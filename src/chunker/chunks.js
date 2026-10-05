import { compareRefs } from '../range.js';
import { getChains, getDocument, indexSpans, readingOrder, sliceSpans, spansText } from './document.js';
import { splitText } from './split.js';

// First matching script wins; other non-whitespace UTF-16 units cost one token.
const LATIN_SCALE = 4;
const BUDGET_TOKENS = 768;
const MIN_TOKENS = 120;
const OVERLAP_TOKENS = 48;
const TOKEN_SCRIPTS = [
	[/\p{Nd}+/gu, 1], [/\p{Script=Latin}+/gu, LATIN_SCALE], [/\p{Script=Cyrillic}+/gu, 3],
	[/[\p{Script=Arabic}\p{Script=Hebrew}]+/gu, 2.5],
	[/[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu, 1.5],
	[/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, 1.4],
	[/[\p{L}\p{M}]+/gu, 2],
];
const ASCII_SCRIPTS = Int8Array.from({ length: 128 }, (_, code) =>
	code === 32 || code >= 9 && code <= 13 ? -1
		: code >= 65 && code <= 90 || code >= 97 && code <= 122 ? 1
			: code >= 48 && code <= 57 ? 0 : TOKEN_SCRIPTS.length);

// Shared selection and splitting; counting stops before chunk output is built.
function* splitGroups(structure, options = {}) {
	let { maxTokens, maxSize, minSize, overlap } = options;
	if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 2 || maxSize !== undefined)) {
		throw new TypeError('Require maxTokens >= 2 and omit maxSize when using maxTokens');
	}
	if ([maxSize, minSize, overlap].some(size => size !== undefined && (!Number.isSafeInteger(size) || size < 0))
			|| maxSize !== undefined && (maxSize < 2 || minSize > maxSize || overlap >= maxSize)) {
		throw new TypeError('Require maxSize >= 2, 0 <= minSize <= maxSize, and 0 <= overlap < maxSize');
	}
	let tokenBudget = maxTokens ?? BUDGET_TOKENS;
	// Scale implicit minimum and overlap proportionally below the default budget.
	let minimumTokens = MIN_TOKENS * Math.min(1, tokenBudget / BUDGET_TOKENS);
	let document = getDocument(structure);
	let unicode = new Map();
	for (let { sections: group, tokens } of groupSections(sections(document), maxSize, minSize, minimumTokens, unicode)) {
		// Convert the estimated token budget to characters once per group.
		// Explicit limits use UTF-16 units, including inserted outline context.
		let scale = maxSize === undefined
			? (group.length === 1 ? group[0].textLength : spansText(group.flatMap(section => section.spans)).length) / tokens
			: maxSize / BUDGET_TOKENS;
		let budget = maxSize ?? Math.max(2, Math.floor(tokenBudget * scale));
		let minimum = minSize ?? Math.floor(minimumTokens * scale);
		let carry = overlap ?? Math.floor(OVERLAP_TOKENS * minimumTokens / MIN_TOKENS * scale);
		if (minimum > budget || carry >= budget) throw new TypeError('minSize and overlap must fit within the chunk budget');
		// Context must also leave room for the caller's minimum and overlap.
		let allowance = Math.min(Math.floor(budget / 4), budget - Math.max(2, minimum, carry + 1));
		if (maxSize === undefined) allowance = Math.min(allowance, (tokenBudget - 2) * scale);
		let measureContext = maxSize === undefined ? text => estimateTokens(text, unicode) * scale : text => text.length;
		let { spans, contextSize } = selectContext(group, allowance, measureContext);
		let { text, entries } = indexSpans(spans);
		let maximum = Math.floor(budget - contextSize);
		// A group's average density can hide denser passages. Bound each source
		// slice with the same estimator, reserving all selected context up front.
		let tokenOffsets = maxSize === undefined ? cumulativeTokens(text, unicode) : null;
		// Character rounding must still leave room for any single code point.
		let limitEnd = maxSize === undefined
			? (start, end) => fitTokenBudget(tokenOffsets, start, end, Math.max(2 + 1e-9, (budget - contextSize) / scale)) : undefined;
		let preserveWhitespace = offset => {
			// Reuse the ordered span index; splitting can revisit offsets for overlap.
			let low = 0, high = entries.length;
			while (low < high) {
				let middle = Math.floor((low + high) / 2);
				if (entries[middle].end <= offset) low = middle + 1;
				else high = middle;
			}
			let entry = entries[low];
			return !!entry && entry.start <= offset && entry.span.entry.block.type === 'preformatted';
		};
		let pieces = [...splitText(text, maximum, minimum, carry, limitEnd, preserveWhitespace)];
		yield { text, entries, spans, pieces, unicode };
	}
}

export function countChunks(structure, options) {
	let count = 0;
	for (let { pieces } of splitGroups(structure, options)) count += pieces.length;
	return count;
}

// Internal iterator: source spans live only until the caller builds its result.
export function* iterateChunks(structure, options, withSpans = true) {
	for (let { text, entries, spans, pieces, unicode } of splitGroups(structure, options)) {
		let cursor = 0;
		for (let [i, { start, end }] of pieces.entries()) {
			while (entries[cursor].end <= start) cursor++;
			let first = entries[cursor];
			let offset = first.span.start + start - first.start;
			let embedText = embeddingText(text, entries, cursor, start, end);
			let chunk = { text: text.slice(start, end), embedText,
				tokens: Math.round(estimateTokens(embedText, unicode)), outlinePath: first.span.outlinePath,
				pageLabel: pageLabel(structure, first.span.entry, offset),
				sectionPart: i + 1, sectionParts: pieces.length };
			if (withSpans) chunk.spans = sliceSpans(spans, entries, cursor, start, end);
			yield chunk;
		}
	}
}

// One section per outline entry, read in reading order. Auxiliary text --
// captions, tables, footnotes -- reads as paragraphs of the body. A later part
// of a continued paragraph stays in the section its paragraph starts in.
function sections(document) {
	let result = [];
	let type = document.structure.metadata?.processor?.type;
	let excluded = [], references = [], auxiliary = [];
	for (let { block, parent } of document.blocks) {
		excluded.push(excluded[parent] || block.flowClass === 'excluded');
		references.push(references[parent] || !!block.reference);
		auxiliary.push(auxiliary[parent] || block.flowClass === 'auxiliary');
	}
	// The outline entry each text node sits under, in document order
	let outline = flattenOutline(document.structure.catalog?.outline ?? []).sort((a, b) => compareRefs(a.ref, b.ref));
	let boundary = 0;
	let context = { outlinePath: '' };
	let contexts = [];
	for (let entry of document.entries) {
		while (boundary < outline.length && compareRefs(outline[boundary].ref, entry.ref) <= 0) {
			context = outline[boundary++];
		}
		contexts.push(context);
	}
	let chains = getChains(document);
	let section = null, current = null;
	for (let { entry } of readingOrder(document, document.entries.map(entry => ({ entry, start: 0 })))) {
		if (excluded[entry.blockIndex]) continue;
		let context = contexts[chains[entry.index]];
		if (context !== current) {
			current = context;
			result.push(section = { ...context, body: {}, spans: [] });
		}
		let reference = references[entry.blockIndex];
		if (!reference && hasSourceAnchor(entry, type)) {
			section.spans.push({ entry, start: 0, end: entry.node.text.length, outlinePath: section.outlinePath });
		}
		// Classify body text independently of source anchors; excluded furniture,
		// auxiliary text and whitespace are not evidence that a section contains
		// only references.
		if (!auxiliary[entry.blockIndex] && entry.block.type !== 'heading' && /\S/u.test(entry.node.text)) {
			if (reference) section.body.hasReferenceBody = true;
			else section.body.hasNonReferenceBody = true;
		}
	}
	return result.filter(section => section.spans.length);
}

// The path of the last outline entry at or before a ref: the section it sits in.
export function outlinePathAt(structure, ref) {
	let path = '';
	for (let item of flattenOutline(structure.catalog?.outline ?? []).sort((a, b) => compareRefs(a.ref, b.ref))) {
		if (compareRefs(item.ref, ref) > 0) break;
		path = item.outlinePath;
	}
	return path;
}

// Labels are display metadata, never SDT addresses. Catalog boundaries resolve
// starts inside multi-page blocks without loading or decoding text geometry.
export function pageLabel(structure, entry, offset) {
	let { catalog, metadata } = structure;
	if (catalog?.pageMappingType === 'locations') return null;
	let pages = catalog?.pages ?? [];
	let rects = entry.block.anchor?.pageRects ?? [];
	let pageIndex = rects[0]?.[0];
	if (pageIndex === undefined || rects.some(rect => rect[0] !== pageIndex)) {
		let point = [...entry.ref, offset];
		let found = pages.findIndex(page => page.contentRange
			&& compareRefs(page.contentRange[0], point) <= 0 && compareRefs(point, page.contentRange[1]) < 0);
		if (found !== -1) pageIndex = found;
	}
	return pages[pageIndex]?.label || (metadata?.processor?.type === 'pdf' && pageIndex !== undefined ? String(pageIndex + 1) : null);
}

// Filter before sizing so text-only and positioned chunks select the same text.
// Whitespace may be synthesized; keep it for word and paragraph separation.
// Checking anchor presence does not load or decode source geometry.
function hasSourceAnchor({ node, block }, type) {
	if (!/\S/u.test(node.text)) return true;
	if (type === 'pdf') return typeof node.anchor?.textMap === 'string' && node.anchor.textMap.length > 0;
	if (type === 'snapshot' && Number.isSafeInteger(node.anchor?.stream) && node.anchor.stream >= 0) return true;
	if (type === 'epub' || type === 'snapshot') {
		return typeof block.anchor?.selectorMap === 'string' && block.anchor.selectorMap.length > 0;
	}
	return true;
}

// Select context before removing headings. Adjacent identical paths share one
// reservation; if all paths exceed the allowance together, keep only the first.
function selectContext(sections, allowance, measure) {
	let runs = [];
	for (let section of sections) {
		// A heading-only section has no body to attach context to. Keep its text
		// and source anchor instead of producing an empty or unanchored chunk.
		let path = section.headingOnly ? '' : section.outlinePath;
		if (runs.at(-1)?.path !== path) runs.push({ path, size: path ? measure(path + '\n\n') : 0, sections: [] });
		runs.at(-1).sections.push(section);
	}
	let selected = runs.filter(run => run.path && run.size <= allowance);
	let contextSize = selected.reduce((size, run) => size + run.size, 0);
	if (contextSize > allowance) {
		selected = selected.slice(0, 1);
		contextSize = selected[0].size;
	}
	let spans = [];
	for (let run of runs) {
		let context = selected.includes(run) ? run.path : '';
		for (let section of run.sections) {
			for (let span of section.spans) {
				if (context && span.entry.block === section.heading) continue;
				spans.push({ entry: span.entry, start: span.start, end: span.end,
					outlinePath: span.outlinePath, context });
			}
		}
	}
	return { spans, contextSize };
}

function matchingHeading(section) {
	let first = section.spans[0].entry;
	if (first.block.type !== 'heading' || !section.ref
		|| compareRefs(section.ref, first.ref.slice(0, -1)) !== 0) return null;
	let normalize = text => text.replace(/\s+/gu, ' ').trim();
	let text = normalize(first.block.content.map(node => node.text ?? '').join(''));
	let selected = spansText(section.spans.filter(span => span.entry.block === first.block));
	return text && text === normalize(section.title) && text === normalize(selected) ? first.block : null;
}

// Insert context at each selected section's start, including continuation chunks.
function embeddingText(text, entries, cursor, start, end) {
	let result = '', previous = '', offset = start;
	for (let i = cursor; i < entries.length && entries[i].start < end; i++) {
		let context = entries[i].span.context;
		if (context && context !== previous) {
			let at = Math.max(start, entries[i].start);
			result += text.slice(offset, at) + context + '\n\n';
			offset = at;
		}
		previous = context;
	}
	return result + text.slice(offset, end);
}

// Count ASCII directly and classify each distinct Unicode character once per
// group. Costs at UTF-16 offsets let the splitter search without rescanning text.
function cumulativeTokens(text, unicode) {
	let offsets = new Float64Array(text.length + 1);
	for (let i = 0; i < text.length;) {
		let point = text.codePointAt(i), width = point > 0xffff ? 2 : 1;
		let index = tokenScript(point, unicode);
		let cost = index < 0 ? 0 : 1 / (TOKEN_SCRIPTS[index]?.[1] ?? 1);
		while (width--) { offsets[i + 1] = offsets[i] + cost; i++; }
	}
	return offsets;
}

// Only denser-than-average slices need a search. The splitter subsequently
// rounds the endpoint to a code point and prefers paragraph/sentence boundaries.
function fitTokenBudget(offsets, start, end, budget) {
	if (offsets[end] - offsets[start] <= budget) return end;
	let low = start, high = end;
	while (low < high) {
		let mid = Math.ceil((low + high) / 2);
		if (offsets[mid] - offsets[start] <= budget) low = mid;
		else high = mid - 1;
	}
	return low;
}

// Accumulate short sections; a short final run joins the preceding group.
// Keep their spans intact so positions and each chunk's first outline path survive.
function groupSections(sections, maxSize, minSize, minimumTokens, unicode) {
	let useTokens = maxSize === undefined && minSize === undefined;
	let minimum = minSize ?? (maxSize === undefined ? minimumTokens : maxSize * MIN_TOKENS / BUDGET_TOKENS);
	let groups = [];
	for (let source of sections) {
		let text = spansText(source.spans);
		if (!text.trim()) continue;
		let heading = matchingHeading(source);
		let headingOnly = !!heading && source.spans.every(span =>
			span.entry.block === heading || !span.entry.node.text.trim());
		if (source.body.hasReferenceBody && !source.body.hasNonReferenceBody && headingOnly) continue;
		let section = { ...source, textLength: text.length, heading, headingOnly };
		let counts = maxSize === undefined ? countScripts(text, unicode) : null;
		let tokens = counts ? tokensFromCounts(counts) : 0;
		// Group by body size, retaining heading-only sections and all source spans.
		// Context selection still decides whether a heading can be replaced.
		let body = section.heading
			? spansText(section.spans.filter(span => span.entry.block !== section.heading)) || text : text;
		let size = body.length;
		if (useTokens) {
			size = tokens;
			if (body !== text) {
				// Subtract integer counts, not rounded or accumulated token costs.
				let headingCounts = countScripts(spansText(section.spans.filter(span => span.entry.block === heading)), unicode);
				size = tokensFromCounts(counts.map((count, i) => count - headingCounts[i]));
			}
		}
		let previous = groups.at(-1);
		if (previous && previous.size < minimum) {
			previous.sections.push(section);
			previous.size += size + (useTokens ? 0 : 2);
			previous.tokens += tokens;
		}
		else groups.push({ sections: [section], size, tokens });
	}
	mergeTail();
	return groups;

	function mergeTail() {
		let tail = groups.at(-1), previous = groups.at(-2);
		if (!previous || tail.size >= minimum) return;
		groups.pop();
		previous.sections.push(...tail.sections);
		previous.size += tail.size + (useTokens ? 0 : 2);
		previous.tokens += tail.tokens;
	}
}

// A script-aware estimate, not a model tokenizer. Whitespace is free;
// each character is priced once, with punctuation falling through at one token.
export function estimateTokens(text, unicode = new Map()) {
	return tokensFromCounts(countScripts(text, unicode));
}

function countScripts(text, unicode) {
	let counts = new Array(TOKEN_SCRIPTS.length + 1).fill(0);
	for (let i = 0; i < text.length;) {
		let point = text.codePointAt(i), width = point > 0xffff ? 2 : 1;
		let index = tokenScript(point, unicode);
		if (index !== -1) counts[index] += width;
		i += width;
	}
	return counts;
}

// Sum script totals in the original order, preserving rounding and splits.
function tokensFromCounts(counts) {
	return counts.reduce((tokens, count, i) => tokens + count / (TOKEN_SCRIPTS[i]?.[1] ?? 1), 0);
}

function tokenScript(point, cache) {
	if (point < ASCII_SCRIPTS.length) return ASCII_SCRIPTS[point];
	let index = cache.get(point);
	if (index === undefined) {
		let character = String.fromCodePoint(point);
		index = /\s/u.test(character) ? -1 : TOKEN_SCRIPTS.findIndex(([pattern]) => character.search(pattern) !== -1);
		if (index === -1 && !/\s/u.test(character)) index = TOKEN_SCRIPTS.length;
		cache.set(point, index);
	}
	return index;
}

function flattenOutline(items, ancestors = []) {
	if (!Array.isArray(items)) return [];
	return items.flatMap(item => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
		let title = typeof item.title === 'string' && item.title.trim() ? item.title : null;
		let path = title ? [...ancestors, title] : ancestors;
		let validRef = Array.isArray(item.ref) && item.ref.length
			&& item.ref.every(index => Number.isSafeInteger(index) && index >= 0);
		return [
			...(title && validRef ? [{ ref: item.ref, title, outlinePath: path.join(' > ') }] : []),
			...flattenOutline(item.children ?? [], path),
		];
	});
}

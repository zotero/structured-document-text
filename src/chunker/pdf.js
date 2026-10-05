import { parseTextMap, visitCharPositions } from '../pdf/decode.js';
import { HEADER_AXIS_DIR_SHIFT, HEADER_DIR_RTL, isVertical } from '../pdf/constants.js';
import { isWhitespaceChar } from '../pdf/utils.js';
import { TEXT_MAP_MAX_GEOMETRY_ERROR } from '../pdf/text-map.js';
import { getContentRangeBlockSpan } from '../range.js';
import { mergeSpans } from './document.js';

const RECOVERY_TOLERANCE = 0.01; // PDF points.

// Merge selected glyphs into continuous line segments. PDF chunks only select
// text nodes with character maps; block rectangles are never a text fallback.
export class PDFPositionMapper {
	constructor(document) {
		this.document = document;
		this.cache = new WeakMap();
		this.indexes = new WeakMap();
		this.pages = new Map();
	}

	toPositions(spans) {
		let lines = this._lines(spans);
		if (!lines) return null;
		let pages = new Map();
		for (let { pageIndex, rect } of lines) {
			if (!pages.has(pageIndex)) pages.set(pageIndex, []);
			pages.get(pageIndex).push(rect);
		}
		return [...pages].map(([pageIndex, rects]) => ({ pageIndex, rects }));
	}

	toAnchor(spans) {
		let selected = spansByEntry(spans);
		let lines = this._lines(spans, selected);
		if (!lines?.length) return null;
		let pageRects = [], barriers = new Map();
		for (let i = 0; i < lines.length;) {
			let { pageIndex } = lines[i];
			let rect = [...lines[i].rect], row = lines[i].rect, end = i + 1;
			while (end < lines.length && (row = followsLine(lines[end - 1], lines[end], row))) {
				extendRect(rect, lines[end++].rect);
			}
			if (end > i + 1) {
				if (!barriers.has(pageIndex)) barriers.set(pageIndex, this._consolidationBarrier(pageIndex, selected));
				let blocked = barriers.get(pageIndex);
				// A clear whole group proves every growing prefix clear. Only
				// obstructed groups need the individual merge checks.
				if (blocked(expandRect(rect, RECOVERY_TOLERANCE))) {
					rect = [...lines[i].rect];
					for (let j = i + 1; j < end; j++) {
						let candidate = unionRect(rect, lines[j].rect);
						if (blocked(expandRect(candidate, RECOVERY_TOLERANCE))) {
							pageRects.push(anchorRect(pageIndex, rect));
							rect = [...lines[j].rect];
						}
						else rect = candidate;
					}
				}
			}
			pageRects.push(anchorRect(pageIndex, rect));
			i = end;
		}
		return { pageRects };
	}

	resolvePositions(positions) {
		let spans = this.toSpans(positions);
		if (!spans?.length) return null;
		let filled = [];
		for (let span of mergeSpans(spans)) {
			let previous = filled.at(-1);
			if (previous?.entry.block === span.entry.block && span.entry.index > previous.entry.index + 1) {
				let gap = this.document.entries.slice(previous.entry.index + 1, span.entry.index);
				if (gap.every(entry => entry.block === span.entry.block && !/\S/u.test(entry.node.text))) {
					for (let entry of gap) filled.push({ entry, start: 0, end: entry.node.text.length });
				}
			}
			filled.push(span);
		}
		return this.toPositions(filled);
	}

	_lines(spans, selected = spansByEntry(spans)) {
		let lines = [];
		let omitted = new Map();
		let previousSpan, previousGlyph, line;
		let whitespace = false;
		for (let span of spans) {
			if (!adjacentSpans(previousSpan, span)) { previousGlyph = null; whitespace = false; }
			let offset = previousSpan?.entry === span.entry ? previousSpan.end : span.start;
			previousSpan = span;
			let text = span.entry.node.text;
			if (!/\S/u.test(text.slice(span.start, span.end))) { whitespace = true; continue; }
			let geometry = this._characters(span.entry.node);
			let first = geometry ? lowerOffset(geometry, span.start) : 0;
			if (!geometry?.[first] || geometry[first][5] >= span.end) return null;
			let checkedUntil = first;
			for (let i = first; i < geometry.length && geometry[i][5] < span.end; i++) {
				let glyph = geometry[i];
				let pageIndex = glyph[4], rect = glyph;
				// Character maps omit whitespace, so skipped offsets are spaces.
				whitespace ||= glyph[5] > offset;
				let merge = previousGlyph && continuesLine(line, previousGlyph, glyph, whitespace);
				if (merge) {
					if (!omitted.has(pageIndex)) omitted.set(pageIndex, this._omittedGeometry(pageIndex, selected));
					let intersects = omitted.get(pageIndex);
					// Check a whole candidate run once. A clear final box also
					// proves every growing prefix clear. If it fails, use the
					// original per-glyph checks without repeating this lookahead.
					if (i >= checkedUntil) {
						let candidate = [...line], last = glyph, end = i + 1;
						extendRect(candidate, rect);
						while (end < geometry.length && geometry[end][5] < span.end
							&& continuesLine(candidate, last, geometry[end], geometry[end][5] > last[5] + 1)) {
							last = geometry[end++];
							extendRect(candidate, last);
						}
						checkedUntil = end;
						if (!intersects(candidate)) {
							extendRect(line, candidate);
							previousGlyph = last;
							offset = last[5] + 1;
							whitespace = false;
							i = end - 1;
							continue;
						}
					}
					merge = !intersects(unionRect(line, rect));
				}
				if (merge) {
					extendRect(line, rect);
				}
				else {
					line = rect.slice(0, 4);
					lines.push({ pageIndex, rect: line, block: span.entry.block, direction: glyph[6] });
				}
				previousGlyph = glyph;
				offset = glyph[5] + 1;
				whitespace = false;
			}
			whitespace = offset < span.end;
		}
		return lines;
	}

	// Only overlapping blocks need line geometry. Each entry's lines are
	// segmented once per page; only partially selected entries vary by chunk.
	_consolidationBarrier(pageIndex, selected) {
		let page = this._pageGeometry(pageIndex);
		// Tiny widths can accumulate encoder error when rounded to zero. Start
		// with a conservative bound without reading distant character maps.
		// Allow one error per character plus the two run-origin coordinates.
		let bounds = page.bounds ??= indexRects(page.rects.map(({ block, rect }) => {
			let length = page.blockEntries.get(block).reduce((max, entry) => Math.max(max, entry.node.text.length), 1);
			return { block, rect: expandRect(rect, (length + 2) * TEXT_MAP_MAX_GEOMETRY_ERROR) };
		}));
		let unbounded = page.unboundedBlocks ??= new Set(page.unbounded.map(entry => entry.block));
		let selectedBlocks = new Set([...selected.keys()].map(entry => entry.block));
		// Entirely unselected blocks have the same barriers across chunks.
		let wholeBlocks = page.blockLines ??= new Map();
		let lines = new Map();
		return query => {
			let blocks = new Set(unbounded);
			bounds.visit(query, ({ block }) => blocks.add(block));
			for (let block of blocks) {
				// Decoded glyphs bound every line; a distant block needs no segmentation.
				if (!selectedBlocks.has(block)) {
					if (!page.extents.has(block)) page.extents.set(block, this._extent(page, pageIndex, block));
					let extent = page.extents.get(block);
					if (extent && !(extent[0] <= query[2] + 1e-7 && extent[2] >= query[0] - 1e-7
						&& extent[1] <= query[3] + 1e-7 && extent[3] >= query[1] - 1e-7)) continue;
				}
				let cache = selectedBlocks.has(block) ? lines : wholeBlocks;
				if (!cache.has(block)) cache.set(block, this._barrierLines(page, pageIndex, block, selected));
				// Without line geometry or bounds, no candidate can be proved clear.
				let index = cache.get(block);
				if (!index) return true;
				let blocked = false;
				index.visit(query, () => { blocked = true; });
				if (blocked) return true;
			}
			return false;
		};
	}

	_extent(page, pageIndex, block) {
		let extent = [Infinity, Infinity, -Infinity, -Infinity];
		for (let entry of page.blockEntries.get(block)) {
			if (!/\S/u.test(entry.node.text)) continue;
			let chars = this._characters(entry.node);
			if (!chars?.length) return null;
			for (let glyph of chars) if (glyph[4] === pageIndex) extendRect(extent, glyph);
		}
		return extent;
	}

	_barrierLines(page, pageIndex, block, selected) {
		let lines = [];
		for (let entry of page.blockEntries.get(block)) {
			let text = entry.node.text, spans = selected.get(entry) ?? [];
			// Whitespace and entirely selected text are not barriers.
			if (!/\S/u.test(text) || spans.some(span => !/\S/u.test(text.slice(0, span.start) + text.slice(span.end)))) continue;
			if (!page.entryLines.has(entry)) page.entryLines.set(entry, this._unselectedLines(entry, pageIndex, []));
			let entryLines = page.entryLines.get(entry);
			if (entryLines && spans.length) entryLines = this._unselectedLines(entry, pageIndex, spans, entryLines);
			// Missing line geometry uses conservative block bounds, if any.
			if (!entryLines) {
				if (page.unboundedBlocks.has(block)) return null;
				return indexRects(block.anchor.pageRects.filter(rect => rect[0] === pageIndex).map(rect => ({ rect: rect.slice(1) })));
			}
			for (let line of entryLines) lines.push(line);
		}
		return indexRects(lines);
	}

	// Unselected portions of lines count as unrelated text; null if unknown.
	// Once a line starts at the same glyph as one of the entry's whole lines,
	// segmentation repeats it, so only lines next to a selection are recomputed.
	_unselectedLines(entry, pageIndex, spans, whole) {
		let chars = this._characters(entry.node);
		if (!chars?.length) return null;
		let lines = [], previous, line;
		for (let i = 0; i < chars.length; i++) {
			let glyph = chars[i];
			let span = spans.find(span => span.start <= glyph[5] && glyph[5] < span.end);
			if (span) i = lowerOffset(chars, span.end) - 1;
			if (span || glyph[4] !== pageIndex) {
				previous = null;
				continue;
			}
			if (previous && continuesLine(line.rect, previous, glyph, glyph[5] > previous[5] + 1)) {
				extendRect(line.rect, glyph);
				line.end = i + 1;
				previous = glyph;
				continue;
			}
			let k = whole ? lowerStart(whole, i) : 0;
			if (whole?.[k]?.start === i) {
				let limit = spans.reduce((limit, span) => span.start > glyph[5] ? Math.min(limit, lowerOffset(chars, span.start)) : limit, chars.length);
				if (whole[k].end <= limit) {
					while (k < whole.length && whole[k].end <= limit) lines.push(whole[k++]);
					i = whole[k - 1].end - 1;
					previous = null;
					continue;
				}
			}
			line = { rect: glyph.slice(0, 4), start: i, end: i + 1 };
			lines.push(line);
			previous = glyph;
		}
		return lines;
	}

	_pageGeometry(pageIndex) {
		if (this.pages.has(pageIndex)) {
			let page = this.pages.get(pageIndex);
			this.pages.delete(pageIndex);
			this.pages.set(pageIndex, page);
			return page;
		}
		let blocks = getContentRangeBlockSpan(this.document.structure.catalog?.pages?.[pageIndex]?.contentRange, this.document.structure.content.length);
		let entries = blocks ? this.document.entries.slice(this.document.blockStarts[blocks.startIndex],
			this.document.blockStarts[blocks.endIndexExclusive]) : this.document.entries;
		let blockEntries = new Map();
		for (let entry of entries) {
			if (!blockEntries.has(entry.block)) blockEntries.set(entry.block, []);
			blockEntries.get(entry.block).push(entry);
		}
		let rects = [];
		let unbounded = [];
		for (let [block, entries] of blockEntries) {
			let bounds = block.anchor?.pageRects;
			if (bounds?.length && bounds.every(rect => validRect(rect.slice(1)))) {
				for (let [page, ...rect] of bounds) if (page === pageIndex) rects.push({ block, rect });
			}
			else for (let entry of entries) unbounded.push(entry);
		}
		// Keep neighboring pages through a page break without retaining every
		// page's line barriers for the lifetime of the document.
		let page = { blockEntries, unbounded, rects, entryLines: new Map(), extents: new Map() };
		this.pages.set(pageIndex, page);
		if (this.pages.size > 2) this.pages.delete(this.pages.keys().next().value);
		return page;
	}

	_omittedGeometry(pageIndex, selected) {
		let page = this._pageGeometry(pageIndex);
		let selectedBlocks = new Set([...selected.keys()].map(entry => entry.block));
		// One index per page serves every chunk; selected blocks are skipped per query.
		let blocks = page.blocks ??= indexRects([...page.rects]);
		let omitted = rect => blocks.intersects(rect, ({ block }) => !selectedBlocks.has(block));
		let entries = new Set(page.unbounded);
		for (let block of selectedBlocks) {
			for (let entry of page.blockEntries.get(block) ?? []) entries.add(entry);
		}
		let checks = [];
		for (let entry of entries) {
			if (!/\S/u.test(entry.node.text)) continue;
			let spans = selected.get(entry) ?? [];
			if (spans.some(span => !/\S/u.test(entry.node.text.slice(0, span.start) + entry.node.text.slice(span.end)))) continue;
			let chars = this._characters(entry.node);
			if (!chars?.length) continue;
			if (!this.indexes.has(chars)) this.indexes.set(chars, characterTree(chars));
			checks.push({ chars, tree: this.indexes.get(chars), spans });
		}
		if (!checks.length) return omitted;
		return rect => {
			if (omitted(rect)) return true;
			return checks.some(({ chars, tree, spans }) => visitCharacters(tree, chars, rect, pageIndex, () => true, spans));
		};
	}

	toSpans(positions) {
		let pages = new Map();
		for (let [index, position] of positions.entries()) {
			if (!Number.isInteger(position.pageIndex) || position.pageIndex < 0 || 'nextPageIndex' in position) return null;
			let ranges = [[position.pageIndex, position.rects]];
			if (position.nextPageRects !== undefined) ranges.push([position.pageIndex + 1, position.nextPageRects]);
			for (let [page, rects] of ranges) {
				if (!Array.isArray(rects) || !rects.length || !rects.every(validRect)) return null;
				if (!pages.has(page)) pages.set(page, []);
				// Expand only recovery queries, so spatial pruning and center tests
				// tolerate the same small shifts without changing saved rectangles.
				for (let [left, bottom, right, top] of rects) pages.get(page).push({ index, rect: [
					left - RECOVERY_TOLERANCE, bottom - RECOVERY_TOLERANCE,
					right + RECOVERY_TOLERANCE, top + RECOVERY_TOLERANCE,
				] });
			}
		}
		let selected = [];
		let resolved = new Set();
		let visited = new Set();
		let queries = new Map([...pages].map(([page, rects]) => [page, indexRects(rects)]));
		for (let page of pages.keys()) {
			let blocks = getContentRangeBlockSpan(this.document.structure.catalog?.pages?.[page]?.contentRange, this.document.structure.content.length);
			if (!blocks) return null;
			let first = this.document.blockStarts[blocks.startIndex];
			let end = this.document.blockStarts[blocks.endIndexExclusive];
			for (let entry of this.document.entries.slice(first, end)) {
				if (visited.has(entry)) continue;
				visited.add(entry);
				let chars = this._characters(entry.node);
				if (!chars?.length) continue;
				if (!this.indexes.has(chars)) this.indexes.set(chars, characterTree(chars));
				let tree = this.indexes.get(chars);
				let hits;
				let firstHit = chars.length, lastHit = -1;
				// Most nodes belong to one page. Only cross-page nodes need a set.
				let entryPages = tree.page === null ? tree.pages ??= new Set(chars.map(char => char[4])) : [tree.page];
				for (let pageIndex of entryPages) {
					let query = queries.get(pageIndex);
					if (!query) continue;
					query.visit(tree.rect, target => {
						visitCharacters(tree, chars, target.rect, pageIndex, i => {
							if (!containsRect(target.rect, chars[i])) return;
							resolved.add(target.index);
							hits ??= new Uint8Array(chars.length);
							hits[i] = 1;
							firstHit = Math.min(firstHit, i); lastHit = Math.max(lastHit, i);
						});
					});
				}
				if (!hits) continue;
				for (let i = firstHit; i <= lastHit; i++) {
					if (!hits[i]) continue;
					let start = chars[i][5];
					while (i < lastHit && hits[i + 1]) i++;
					let end = chars[i][5] + 1;
					while (start > 0 && /\s/u.test(entry.node.text[start - 1])) start--;
					while (end < entry.node.text.length && /\s/u.test(entry.node.text[end])) end++;
					selected.push({ entry, start, end });
				}
			}
		}
		// Individual rectangles may become empty, but every supplied position
		// must still resolve text; otherwise this would silently return a fragment.
		return resolved.size === positions.length ? selected : null;
	}

	_characters(node) {
		if (this.cache.has(node)) return this.cache.get(node);
		let chars = decodeCharacters(node);
		// Cache expected failures too; unexpected errors still throw before caching.
		this.cache.set(node, chars);
		return chars;
	}
}

// Compact local glyph tuples: [x1, y1, x2, y2, page, offset, direction].
// The source representation and Reader positions remain unchanged.
function decodeCharacters(node) {
	if (!node.anchor?.textMap) return null;
	let state = { chars: [], text: node.text, offset: 0, run: null, direction: 0, vertical: false, validated: false };
	for (let run of parseTextMap(node.anchor.textMap)) {
		if (!Array.isArray(run) || run.length < 6) continue;
		state.run = run;
		state.direction = run[0] & ((3 << HEADER_AXIS_DIR_SHIFT) | HEADER_DIR_RTL);
		state.vertical = isVertical((run[0] >> HEADER_AXIS_DIR_SHIFT) & 3);
		state.validated = false;
		if (!visitCharPositions(run, appendCharacter, true, state)) return null;
	}
	let { text, chars, offset } = state;
	while (offset < text.length && isWhitespaceChar(text[offset])) offset++;
	return offset === text.length ? chars : null;
}

function appendCharacter(start, end, state) {
	if (!Number.isFinite(start) || !Number.isFinite(end)) return;
	if (start > end) return false;
	let { run, text, chars, direction, vertical, offset } = state;
	if (!state.validated) {
		let acrossStart = run[vertical ? 2 : 3], acrossEnd = run[vertical ? 4 : 5];
		if (!Number.isInteger(run[1]) || run[1] < 0 || !Number.isFinite(acrossStart)
			|| !Number.isFinite(acrossEnd) || acrossStart > acrossEnd) return false;
		state.validated = true;
	}
	while (offset < text.length && isWhitespaceChar(text[offset])) offset++;
	if (offset === text.length) return false;
	chars.push(vertical ? [run[2], start, run[4], end, run[1], offset, direction]
		: [start, run[3], end, run[5], run[1], offset, direction]);
	state.offset = offset + 1;
}

function adjacentSpans(previous, span) {
	if (!previous || previous.entry.block !== span.entry.block) return false;
	if (previous.entry === span.entry) {
		return previous.end <= span.start && !/\S/u.test(span.entry.node.text.slice(previous.end, span.start));
	}
	return span.entry.index === previous.entry.index + 1
		&& !/\S/u.test(previous.entry.node.text.slice(previous.end) + span.entry.node.text.slice(0, span.start));
}

function spansByEntry(spans) {
	let selected = new Map();
	for (let span of spans) {
		if (!selected.has(span.entry)) selected.set(span.entry, []);
		selected.get(span.entry).push(span);
	}
	return selected;
}

// Keep consolidation within one paragraph or simple list item. Same-line
// fragments may overlap vertically (e.g. superscripts), but must advance
// in the writing direction across a small gap. A following line must overlap
// the preceding row of fragments, so distant columns stay separate.
// Returns the row containing b, or null.
function followsLine(a, b, row) {
	if (a.block !== b.block || (b.block.type !== 'paragraph' && b.block.type !== 'listitem') || a.pageIndex !== b.pageIndex
			|| a.direction !== b.direction || b.direction & (3 << HEADER_AXIS_DIR_SHIFT)) return null;
	let heightA = a.rect[3] - a.rect[1], heightB = b.rect[3] - b.rect[1];
	if (heightA <= 0 || heightB <= 0) return null;
	let overlap = Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]);
	let forward = b.direction & HEADER_DIR_RTL ? b.rect[2] <= a.rect[2] : b.rect[0] >= a.rect[0];
	let spacing = Math.max(a.rect[0], b.rect[0]) - Math.min(a.rect[2], b.rect[2]);
	// Measure the gap by the taller fragment: a superscript is followed by full-size text.
	if (overlap > 0 && forward && spacing <= Math.max(heightA, heightB) / 2) return unionRect(row, b.rect);
	let gap = a.rect[1] - b.rect[3];
	return gap >= 0 && gap <= Math.max(heightA, heightB)
		&& Math.min(row[2], b.rect[2]) > Math.max(row[0], b.rect[0]) ? b.rect : null;
}

function expandRect([left, bottom, right, top], margin) {
	return [left - margin, bottom - margin, right + margin, top + margin];
}

// Snap roundoff near the text-map encoder's six-decimal grid only in saved anchors.
function anchorRect(pageIndex, rect) {
	return [pageIndex, ...rect.map(value => {
		let rounded = Math.round(value * 1e6) / 1e6;
		return Math.abs(rounded - value) <= 1e-9 ? rounded : value;
	})];
}

function extendRect(target, rect) {
	target[0] = Math.min(target[0], rect[0]); target[1] = Math.min(target[1], rect[1]);
	target[2] = Math.max(target[2], rect[2]); target[3] = Math.max(target[3], rect[3]);
}

function unionRect(a, b) {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function continuesLine(line, previous, glyph, whitespace) {
	if (previous[6] !== glyph[6] || previous[4] !== glyph[4]) return false;
	let a = previous, b = glyph;
	let along = glyph[6] & 2 ? 1 : 0, across = 1 - along;
	let height = Math.min(a[across + 2] - a[across], b[across + 2] - b[across]);
	let lineHeight = Math.max(line[across + 2] - line[across], b[across + 2] - b[across]);
	let overlap = Math.min(line[across + 2], b[across + 2]) - Math.max(line[across], b[across]);
	let gap = Math.max(a[along], b[along]) - Math.min(a[along + 2], b[along + 2]);
	let spacing = Math.max(height * (whitespace ? 1.5 : 0.5), a[along + 2] - a[along], b[along + 2] - b[along]);
	// Compare the entire segment with the larger height, so tall glyphs and
	// gradual baseline drift cannot grow one rectangle across nearby lines.
	return height > 0 && overlap >= lineHeight * 0.6 && gap <= spacing;
}

// Index omitted geometry once per selected page, rather than scanning every
// omitted block for every glyph. Prefix maxima also handle tall overlapping boxes.
function indexRects(rects) {
	let axis = spreadAxis(rects);
	rects.sort((a, b) => a.rect[axis] - b.rect[axis]);
	let top = -Infinity;
	let tops = rects.map(({ rect }) => top = Math.max(top, rect[axis + 2]));
	return {
		// Merging must not enclose omitted text. Edge-only contact is allowed.
		intersects: (rect, include) => scan(rect, false, include),
		// Recovery includes edge matches, with the existing numerical tolerance.
		visit: (rect, visit) => scan(rect, true, visit),
	};

	function scan([left, bottom, right, top], includeEdges, callback) {
		let minimum = axis ? bottom : left, maximum = axis ? top : right;
		let low = 0, high = rects.length;
		while (low < high) {
			let mid = (low + high) >>> 1;
			if (tops[mid] < minimum - 1e-7) low = mid + 1;
			else high = mid;
		}
		for (let i = low; i < rects.length && rects[i].rect[axis] <= maximum + 1e-7; i++) {
			let { rect } = rects[i];
			if (includeEdges) {
				if (rect[0] <= right + 1e-7 && rect[2] >= left - 1e-7 && rect[1] <= top + 1e-7 && rect[3] >= bottom - 1e-7) callback(rects[i]);
			}
			else if (rect[0] < right && rect[2] > left && rect[1] < top && rect[3] > bottom && (!callback || callback(rects[i]))) return true;
		}
		return false;
	}
}

function spreadAxis(rects) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let width = 0, height = 0;
	for (let { rect } of rects) {
		minX = Math.min(minX, rect[0]); maxX = Math.max(maxX, rect[2]);
		minY = Math.min(minY, rect[1]); maxY = Math.max(maxY, rect[3]);
		width += rect[2] - rect[0]; height += rect[3] - rect[1];
	}
	// Prefer the axis with less overlap, rather than just the wider page axis.
	return (maxX - minX) / (width || 1e-7) > (maxY - minY) / (height || 1e-7) ? 0 : 1;
}

function lowerStart(lines, index) {
	let low = 0, high = lines.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (lines[mid].start < index) low = mid + 1;
		else high = mid;
	}
	return low;
}

function lowerOffset(chars, offset) {
	let low = 0, high = chars.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (chars[mid][5] < offset) low = mid + 1;
		else high = mid;
	}
	return low;
}

// A source-ordered bounding tree is built once per text node. Whole selected
// subtrees can be skipped without constructing the complement for each chunk.
function characterTree(chars, start = 0, end = chars.length) {
	if (end - start > 16) {
		let middle = (start + end) >>> 1;
		let left = characterTree(chars, start, middle), right = characterTree(chars, middle, end);
		let rect = [...left.rect];
		extendRect(rect, right.rect);
		return { start, end, rect, left, right, page: left.page === right.page ? left.page : null };
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let page = chars[start][4];
	for (let i = start; i < end; i++) {
		let char = chars[i], x = (char[0] + char[2]) / 2, y = (char[1] + char[3]) / 2;
		if (char[4] !== page) page = null;
		minX = Math.min(minX, x); maxX = Math.max(maxX, x);
		minY = Math.min(minY, y); maxY = Math.max(maxY, y);
	}
	return { start, end, rect: [minX, minY, maxX, maxY], page };
}

function visitCharacters(tree, chars, rect, page, visit, spans) {
	if (tree.page !== null && tree.page !== page) return false;
	let bounds = tree.rect;
	if (bounds[2] < rect[0] - 1e-7 || bounds[0] > rect[2] + 1e-7
		|| bounds[3] < rect[1] - 1e-7 || bounds[1] > rect[3] + 1e-7
		|| spans?.some(span => span.start <= chars[tree.start][5] && span.end > chars[tree.end - 1][5])) return false;
	if (tree.left) return visitCharacters(tree.left, chars, rect, page, visit, spans)
		|| visitCharacters(tree.right, chars, rect, page, visit, spans);
	for (let i = tree.start; i < tree.end; i++) {
		let char = chars[i];
		if (char[4] === page && !spans?.some(span => char[5] >= span.start && char[5] < span.end)
			&& containsCenter(rect, char) && visit(i)) return true;
	}
	return false;
}

function validRect(rect) {
	return Array.isArray(rect) && rect.length === 4 && Number.isFinite(rect[0]) && Number.isFinite(rect[1])
		&& Number.isFinite(rect[2]) && Number.isFinite(rect[3])
		&& rect[0] <= rect[2] && rect[1] <= rect[3];
}

function containsCenter(rect, charRect) {
	let y = (charRect[1] + charRect[3]) / 2;
	if (y < rect[1] - 1e-7 || y > rect[3] + 1e-7) return false;
	let x = (charRect[0] + charRect[2]) / 2;
	return x >= rect[0] - 1e-7 && x <= rect[2] + 1e-7;
}

function containsRect(rect, glyph) {
	return glyph[0] >= rect[0] - 1e-7 && glyph[1] >= rect[1] - 1e-7
		&& glyph[2] <= rect[2] + 1e-7 && glyph[3] <= rect[3] + 1e-7;
}

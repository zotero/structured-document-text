import { isLeafBlock, sameRef } from '../range.js';

const documents = new WeakMap();

// One immutable index shared by chunking and source mapping. Entries identify
// text nodes by document order; spans are just { entry, start, end }.
export function getDocument(structure) {
	if (documents.has(structure)) return documents.get(structure);
	let document = { structure, blocks: [], entries: [], blockStarts: [] };
	function visit(block, ref, parent) {
		if (!block || typeof block.text === 'string') return;
		let blockIndex = document.blocks.length;
		document.blocks.push({ block, ref, parent });
		if (isLeafBlock(block)) {
			for (let [i, node] of (block.content ?? []).entries()) {
				if (typeof node?.text === 'string' && node.text.length) {
					document.entries.push({ node, block, ref: [...ref, i], blockIndex, index: document.entries.length });
				}
			}
		}
		else {
			for (let [i, child] of block.content.entries()) visit(child, [...ref, i], blockIndex);
		}
	}
	for (let [i, block] of structure.content.entries()) {
		document.blockStarts.push(document.entries.length);
		visit(block, [i], null);
	}
	document.blockStarts.push(document.entries.length);
	documents.set(structure, document);
	return document;
}

export function mergeSpans(spans) {
	let merged = [];
	for (let span of [...spans].sort((a, b) => a.entry.index - b.entry.index || a.start - b.start)) {
		let previous = merged.at(-1);
		if (previous?.entry === span.entry && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

const chains = new WeakMap();

// Each entry's chain: the first entry of the paragraph it belongs to. A later
// part of a continued paragraph chains back through previousPart links, which
// run backward in document order and never from excluded text. For a paragraph
// split by a caption -- part one at entry 10, the caption at 11, part two at
// 12 -- the chains are 10, 11 and 10, so part two sorts ahead of the caption.
export function getChains(document) {
	if (chains.has(document)) return chains.get(document);
	let blockByRef = new Map(document.blocks.map(({ ref }, index) => [ref.join('.'), index]));
	let excluded = index => index !== null && index !== undefined
		&& (document.blocks[index].block.flowClass === 'excluded' || excluded(document.blocks[index].parent));
	let firstEntry = [], result = [];
	for (let entry of document.entries) {
		firstEntry[entry.blockIndex] ??= entry.index;
		let index = entry.blockIndex, block = entry.block;
		while (block.previousPart) {
			let previous = blockByRef.get(block.previousPart.join('.'));
			if (previous === undefined || previous >= index || excluded(previous)) break;
			index = previous;
			block = document.blocks[index].block;
		}
		result.push(firstEntry[index] ?? firstEntry[entry.blockIndex]);
	}
	chains.set(document, result);
	return result;
}

// Document order, except that a paragraph's later parts follow its first,
// ahead of anything between them, so that an auxiliary block never breaks them up.
export function readingOrder(document, spans) {
	let chain = getChains(document);
	return [...spans].sort((a, b) => chain[a.entry.index] - chain[b.entry.index]
		|| a.entry.index - b.entry.index || a.start - b.start);
}

// One serialization rule for both chunking and recovery. Preserve preformatted
// whitespace; trim ordinary block edges and separate omitted text by a space.
function serializeSpans(spans, indexed) {
	let text = '', entries = [];
	let previousEntry, previousEnd;
	for (let index = 0; index < spans.length; index++) {
		let source = spans[index];
		let entry = source.entry;
		let raw = source.entry.node.text.slice(source.start, source.end);
		let trimmed = entry.block.type === 'preformatted' ? raw : raw.trim();
		if (!trimmed) continue;
		let start = source.start + (trimmed.length === raw.length ? 0 : raw.length - raw.trimStart().length);
		let end = start + trimmed.length;
		let separator = previousEntry ? '\n\n' : '';
		if (previousEntry?.block === entry.block) {
			if (previousEntry === entry) separator = entry.node.text.slice(previousEnd, start);
			else {
				separator = previousEntry.node.text.slice(previousEnd);
				for (let i = previousEntry.ref.at(-1) + 1; i < entry.ref.at(-1); i++) separator += entry.block.content[i].text ?? '';
				separator += entry.node.text.slice(0, start);
			}
			if (/\S/u.test(separator)) separator = ' ';
		}
		else if (previousEntry && (sameRef(previousEntry.block.nextPart, entry.ref.slice(0, -1))
			|| sameRef(entry.block.previousPart, previousEntry.ref.slice(0, -1)))
			&& reachesBlockEdge(previousEntry, previousEnd, true) && reachesBlockEdge(entry, start, false)) {
			separator = previousEntry.block.type === 'preformatted' && entry.block.type === 'preformatted'
				? (/\n$/u.test(text) || /^\r?\n/u.test(trimmed) ? '' : '\n') : ' ';
		}
		text += separator;
		if (indexed) {
			let span = start === source.start && end === source.end ? source : { ...source, start, end };
			entries.push({ span, index, start: text.length, end: text.length + trimmed.length });
		}
		text += trimmed;
		previousEntry = entry; previousEnd = end;
	}
	return { text, entries };
}

// Partial selections must not turn omitted text at a part boundary into a join.
// Whitespace-only edge nodes can be synthesized or trimmed during serialization.
function reachesBlockEdge(entry, offset, end) {
	if (/\S/u.test(end ? entry.node.text.slice(offset) : entry.node.text.slice(0, offset))) return false;
	let index = entry.ref.at(-1);
	let nodes = end ? entry.block.content.slice(index + 1) : entry.block.content.slice(0, index);
	return nodes.every(node => !/\S/u.test(node.text ?? ''));
}

export function spansText(spans) {
	return serializeSpans(spans, false).text;
}

export function indexSpans(spans) {
	return serializeSpans(spans, true);
}

export function sliceSpans(spans, entries, cursor, start, end) {
	let first = entries[cursor];
	while (cursor + 1 < entries.length && entries[cursor + 1].start < end) cursor++;
	let last = entries[cursor];
	// Keep intervening whitespace nodes: their anchors can establish continuity.
	let selected = spans.slice(first.index, last.index + 1);
	selected[0] = { ...selected[0], start: first.span.start + start - first.start };
	selected[selected.length - 1] = { ...selected.at(-1), end: last.span.end - (last.end - end) };
	return selected;
}

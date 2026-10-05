import { nfcToOriginalLocal } from '../dom/deltamap.js';

// EPUB and snapshot mappers supply source endpoints and adjacency rules;
// grouping and recovery operate on the same document spans for both formats.
export function toDOMPositions(mapper, spans) {
	let elementBlocks = new Set(spans.filter(span => !mapper.hasAnchor(span.entry)
		&& /\S/u.test(span.entry.node.text.slice(span.start, span.end))).map(span => span.entry.block));
	let groups = [];
	let previous;
	let previousIndex;
	for (let span of spans) {
		let anchored = mapper.hasAnchor(span.entry);
		let element = elementBlocks.has(span.entry.block);
		// Synthetic whitespace has no endpoint, but need not break an otherwise
		// contiguous source range. Never bridge an omitted document entry.
		if (!anchored && !element && !/\S/u.test(span.entry.node.text)) {
			if (previous && span.entry.index === previousIndex + 1) previousIndex = span.entry.index;
			else previous = undefined;
			continue;
		}
		let connected = false;
		if (previous) {
			if (element) connected = previous.entry.block === span.entry.block;
			else if (anchored && !elementBlocks.has(previous.entry.block)) {
				connected = continuesTextRange(mapper, previous, span, previousIndex);
			}
		}
		if (span.entry.block.type !== 'preformatted' && !/\S/u.test(span.entry.node.text.slice(span.start, span.end))) {
			if (connected) { previous = span; previousIndex = span.entry.index; }
			continue;
		}
		if (connected) groups.at(-1).push(span);
		else groups.push([span]);
		previous = span;
		previousIndex = span.entry.index;
	}
	return groups.map(group => elementBlocks.has(group[0].entry.block)
		? mapper.toElementPosition(group[0].entry, group) : mapper.toPosition(group));
}

function continuesTextRange(mapper, previous, span, previousIndex) {
	if (previous.entry === span.entry) return previous.end === span.start;
	if (span.entry.index !== previousIndex + 1 || !mapper.isAdjacent(previous.entry, span.entry)) return false;
	let gap = previous.entry.node.text.slice(previous.end) + span.entry.node.text.slice(0, span.start);
	return !/\S/u.test(gap);
}

export function toDOMSpans(mapper, positions) {
	let spans = [];
	for (let position of positions) {
		let range = mapper.toRange(position);
		let selected = range && sliceDocument(mapper.document, range);
		if (!selected?.length) return null;
		// Reader ranges can cross whitespace/omissions in the extracted stream.
		// Generated positions still split at excluded entries and source gaps.
		for (let span of selected) spans.push(span);
	}
	return spans;
}

// Only unique leaf-element anchors can stand for a complete block. Keep these
// distinct from character ranges: synthetic text has no source text offsets.
export function elementRanges(document, keyForBlock = block => block.anchor?.selectorMap) {
	let elements = new Map();
	for (let entry of document.entries) {
		let key = keyForBlock(entry.block);
		if (!key) continue;
		let range = elements.get(key);
		let end = [entry.index, entry.node.text.length];
		if (range?.block === entry.block) range.end = end;
		else elements.set(key, elements.has(key) ? null
			: { start: [entry.index, 0], end, block: entry.block, element: true });
	}
	return elements;
}

/**
 * Invert nfcToOriginalLocal(): the NFC offset within an entry that maps to a
 * local original-space offset. The mapping is monotonic, so binary search
 * finds it.
 *
 * Ported from the reader's src/common/sdt/deltamap-invert.ts
 *
 * @param {string | undefined} deltaMap
 * @param {number} entryStartNFC
 * @param {number} localOrig
 * @param {number} maxNFC
 * @returns {number}
 */
export function localOriginalToNFC(deltaMap, entryStartNFC, localOrig, maxNFC) {
	if (!deltaMap) return Math.max(0, Math.min(localOrig, maxNFC));
	let lo = 0;
	let hi = maxNFC;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (nfcToOriginalLocal(deltaMap, entryStartNFC, mid) < localOrig) {
			lo = mid + 1;
		}
		else {
			hi = mid;
		}
	}
	return lo;
}

// Use the Reader's inverse mapping for offsets within normalized sequences.
// Reject out-of-node offsets rather than inventing a source endpoint.
export function normalizedOffset(node, original, start = 0, length = node.text.length) {
	let map = node.anchor?.deltaMap;
	let maximum = originalOffset(node, start, length);
	if (maximum === null || !Number.isSafeInteger(original) || original < 0 || original > maximum) return null;
	return start + localOriginalToNFC(map, start, original, length);
}

// Malformed normalization data is an unresolved anchor, not a document failure.
export function originalOffset(node, start, offset) {
	let map = node.anchor?.deltaMap;
	if (map !== undefined && typeof map !== 'string') return null;
	let original = nfcToOriginalLocal(map, start, offset);
	return Number.isSafeInteger(original) && original >= 0 ? original : null;
}

// Format decoders resolve endpoints directly to [entry index, text offset].
// No repeated tree traversal or conversion through general content-tree ranges.
function sliceDocument(document, { start, end }) {
	let first = document.entries[start[0]];
	let last = document.entries[end[0]];
	if (!first || !last || start[0] > end[0] || (start[0] === end[0] && start[1] >= end[1])
			|| start[1] < 0 || start[1] > first.node.text.length || end[1] < 0 || end[1] > last.node.text.length) return null;
	return document.entries.slice(start[0], end[0] + 1)
		.map(entry => ({ entry, start: entry === first ? start[1] : 0,
			end: entry === last ? end[1] : entry.node.text.length }))
		.filter(span => span.end > span.start);
}

import { buildDomMapIndex, matchDomMapSelector } from '../dom/snapshot/dommap.js';
import { elementRanges, normalizedOffset, originalOffset, toDOMPositions, toDOMSpans } from './dom.js';

// Text uses the body's source stream; synthetic content keeps element selectors.
export class SnapshotPositionMapper {
	constructor(document) {
		this.document = document;
		this.selectors = new Map();
		this.elements = elementRanges(document);
		this.ranges = document.entries.filter(entry => this.hasAnchor(entry))
			.map(entry => ({ entry, start: sourceOffset(entry, 0), end: sourceOffset(entry, entry.node.text.length) }))
			.filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.end > range.start)
			.sort((a, b) => a.start - b.start);
	}

	toPositions(spans) {
		return toDOMPositions(this, spans);
	}

	toSpans(positions) {
		return toDOMSpans(this, positions);
	}

	hasAnchor(entry) {
		return Number.isSafeInteger(entry.node.anchor?.stream) && entry.node.anchor.stream >= 0;
	}

	isAdjacent(a, b) {
		return sourceOffset(a, a.node.text.length) === sourceOffset(b, 0);
	}

	toElementPosition(entry) {
		let value = entry.block.anchor?.selectorMap;
		return typeof value === 'string' && value ? { type: 'CssSelector', value } : null;
	}

	toPosition(spans) {
		let start = sourceOffset(spans[0].entry, spans[0].start);
		let end = sourceOffset(spans.at(-1).entry, spans.at(-1).end);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
		// Browser HTML parsing can insert elements (e.g. tbody) absent from the
		// extractor's DOM map. Source text offsets survive these tree-only repairs.
		return { type: 'TextPositionSelector', start, end };
	}

	toRange(position) {
		if (position.type === 'CssSelector' && position.refinedBy == null) {
			let element = this.elements.get(position.value);
			if (element) return element;
		}
		let range = this._streamRange(position);
		if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
				|| range.start < 0 || range.end <= range.start) return null;
		let start = this._contentPoint(range.start, false);
		let end = this._contentPoint(range.end, true);
		return start && end ? { start, end } : null;
	}

	_streamRange(position) {
		if (position.type === 'TextPositionSelector') return position;
		if (position.type !== 'CssSelector' || typeof position.value !== 'string') return null;
		this.domIndex ??= buildDomMapIndex(this.document.structure.catalog?.domMap);
		if (!this.selectors.has(position.value)) {
			this.selectors.set(position.value, this.domIndex && matchDomMapSelector(this.domIndex, position.value)?.node);
		}
		let element = this.selectors.get(position.value);
		if (!element) return null;
		let range = position.refinedBy ?? { type: 'TextPositionSelector', start: 0, end: element.textLength };
		if (range.type !== 'TextPositionSelector' || !Number.isSafeInteger(range.start)
				|| !Number.isSafeInteger(range.end) || range.start < 0 || range.end > element.textLength
				|| range.start >= range.end) return null;
		return { start: element.textStart + range.start, end: element.textStart + range.end };
	}

	_contentPoint(offset, isEnd) {
		let lo = 0;
		let hi = this.ranges.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			let range = this.ranges[mid];
			if (isEnd ? range.start < offset : range.end <= offset) lo = mid + 1;
			else hi = mid;
		}
		let range = this.ranges[isEnd ? lo - 1 : lo];
		if (!range) return null;
		let local = normalizedOffset(range.entry.node, Math.max(0, Math.min(offset - range.start, range.end - range.start)));
		return local === null ? null : [range.entry.index, local];
	}
}

function sourceOffset(entry, offset) {
	let original = originalOffset(entry.node, 0, offset);
	return original === null ? NaN : entry.node.anchor.stream + original;
}

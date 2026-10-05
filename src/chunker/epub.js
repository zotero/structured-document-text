import { expandBlockAnchor, expandSelectorMap, findCommonCFIPath, parseSelectorMapEntries } from '../dom/epub/decode.js';
import { elementRanges, localOriginalToNFC, originalOffset, toDOMPositions, toDOMSpans } from './dom.js';

// Source paths point directly into the shared document index. Merged SDT text
// nodes have one CFI entry per original DOM text node.
export class EPUBPositionMapper {
	constructor(document) {
		this.document = document;
		this.elements = elementRanges(document, block => typeof block.anchor?.selectorMap === 'string'
			&& stripAssertions(block.anchor.selectorMap));
		this.entries = new Map();
		this.paths = new Map();
		for (let entry of document.entries) {
			let blockMap = entry.block.anchor?.selectorMap;
			let nodeMap = entry.node.anchor?.selectorMap;
			if (typeof blockMap !== 'string' || !blockMap || typeof nodeMap !== 'string') continue;
			let expanded = expandSelectorMap(blockMap, nodeMap);
			let parts = [];
			let start = 0;
			for (let { path, length } of parseSelectorMapEntries(expanded) ?? [{ path: expanded, length: entry.node.text.length }]) {
				let part = { path, length, start, entry };
				parts.push(part);
				let key = stripAssertions(path);
				this.paths.set(key, this.paths.has(key) ? null : part);
				start += length;
			}
			this.entries.set(entry, parts);
		}
	}

	toPositions(spans) {
		return toDOMPositions(this, spans);
	}

	toSpans(positions) {
		return toDOMSpans(this, positions);
	}

	hasAnchor(entry) {
		return this.entries.has(entry);
	}

	isAdjacent(a, b) {
		return a.block.anchor?.selectorMap?.split('!')[0] === b.block.anchor?.selectorMap?.split('!')[0];
	}

	toElementPosition(entry, spans) {
		// Preserve text endpoints around synthetic content instead of replacing
		// the whole mixed paragraph with a collapsed element CFI.
		return this.toPosition(spans);
	}

	toPosition(spans) {
		let start = this._sourcePoint(spans[0], spans[0].start);
		let end = this._sourcePoint(spans.at(-1), spans.at(-1).end, true);
		if (!start || !end) return null;
		let position = expandBlockAnchor(start.path);
		if (start.path !== end.path || start.offset !== null || end.offset !== null) {
			let { common, remainderA, remainderB } = findCommonCFIPath(start.path, end.path);
			// Keep explicit character ranges, including a single character. Null
			// addresses the containing element and must not become offset zero.
			let at = point => point.offset === null ? '' : `:${point.offset}`;
			position.value = `epubcfi(${common},${remainderA}${at(start)},${remainderB}${at(end)})`;
		}
		return position;
	}

	toRange(position) {
		if (position.type !== 'FragmentSelector' || typeof position.value !== 'string') return null;
		let match = stripAssertions(position.value).match(/^epubcfi\((.*)\)$/s);
		if (!match) return null;
		let parts = match[1].split(',');
		if (parts.length !== 1 && parts.length !== 3) return null;
		if (parts.length === 1 && this.elements.has(parts[0])) return this.elements.get(parts[0]);
		let start = this._contentPoint(parts[0] + (parts[1] ?? ''), false);
		let end = this._contentPoint(parts[0] + (parts[2] ?? ''), true);
		return start && end ? { start, end } : null;
	}

	_sourcePoint(span, offset, isEnd = false) {
		if (!this.hasAnchor(span.entry)) {
			let path = span.entry.block.anchor?.selectorMap;
			return path ? { path, offset: null } : null;
		}
		let part = this.entries.get(span.entry)?.find(part =>
			offset < part.start + part.length || (isEnd && offset === part.start + part.length));
		let original = part && originalOffset(span.entry.node, part.start, offset - part.start);
		return original == null ? null : { path: part.path, offset: original };
	}

	_contentPoint(point, isEnd) {
		let match = point.match(/^(.*?):(\d+)$/s);
		let path = match ? match[1] : point;
		if (path.includes(':') || match && !Number.isSafeInteger(Number(match[2]))) return null;
		// An empty relative selectorMap can give a text node its block's path.
		// Without a character offset, the endpoint still addresses the block.
		if (!match && this.elements.has(path)) return this.elements.get(path)?.[isEnd ? 'end' : 'start'] ?? null;
		let part = this.paths.get(path);
		if (!part) {
			if (this.paths.has(path)) return null; // Ambiguous duplicate text path.
			let parent;
			for (let [prefix, range] of this.elements) {
				if (path === prefix || path.startsWith(prefix) && /^[/:!]/u.test(path.slice(prefix.length))) {
					if (!range) return null;
					if (!parent || prefix.length > parent.prefix.length) parent = { prefix, range };
				}
			}
			// An unknown text path must not expand to a block with known text
			// anchors. Keep the element fallback for wholly synthetic text.
			if (match && parent?.range.block.content.some(node => typeof node.anchor?.selectorMap === 'string')) return null;
			return parent ? parent.range[isEnd ? 'end' : 'start'] : null;
		}
		let { entry, start, length } = part;
		if (originalOffset(entry.node, start, length) === null) return null;
		// A CFI addresses the original DOM. Re-extraction can shorten this
		// resolved text node; the inverse map clamps to this part's boundary.
		let offset = match ? localOriginalToNFC(entry.node.anchor?.deltaMap, start, Number(match[2]), length)
			: isEnd ? length : 0;
		return [entry.index, start + offset];
	}
}

function stripAssertions(value) {
	return value.replace(/\[(?:\^.|[^\]^])*\]/gs, '');
}

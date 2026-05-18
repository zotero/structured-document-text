import { splitContentRange } from './range.js';

/**
 * Convert a structure object into a fulltext string for the given page indexes.
 *
 * @param {Object} structure - The structured data from getFullStructure/getStructure
 * @param {number[]} pageIndexes - Array of page indexes to include
 * @returns {string} The fulltext string, NFC normalized
 */
export function getFulltextFromStructuredText(structure, pageIndexes) {
	const emittedTextSpans = new Map();
	const blockTextIndexes = new Map();
	const blockTexts = [];
	const content = Array.isArray(structure?.content) ? structure.content : [];
	const pages = Array.isArray(structure?.catalog?.pages) ? structure.catalog.pages : [];

	for (const pageIndex of pageIndexes) {
		const page = pages[pageIndex];
		if (!page || !Array.isArray(page.contentRanges)) continue;

		for (const range of page.contentRanges) {
			for (const entry of getRangeBlockTexts(content, range, emittedTextSpans)) {
				if (!entry.text) {
					continue;
				}
				const existingIndex = blockTextIndexes.get(entry.blockIndex);
				if (existingIndex === undefined) {
					blockTextIndexes.set(entry.blockIndex, blockTexts.length);
					blockTexts.push(entry.text);
				}
				else {
					blockTexts[existingIndex] += entry.text;
				}
			}
		}
	}

	return blockTexts.join('\n\n').replace(/[ \t]+$/gm, '').trim();
}

function getRangeBlockTexts(content, range, emittedTextSpans) {
	let parts;
	try {
		parts = splitContentRange(range, content);
	}
	catch (_) {
		return [];
	}

	const startTopLevel = parts.start.ref?.[0];
	const endTopLevel = parts.end.ref?.[0];
	if (
		!Number.isInteger(startTopLevel)
		|| !Number.isInteger(endTopLevel)
		|| startTopLevel > endTopLevel
	) {
		return [];
	}

	const blockTexts = [];
	for (let i = startTopLevel; i <= endTopLevel; i++) {
		const block = content[i];
		if (!block || block.artifact) {
			continue;
		}
		const text = getBlockRangeText(
			block,
			[i],
			i === startTopLevel ? parts.start : null,
			i === endTopLevel ? parts.end : null,
			emittedTextSpans
		);
		if (text) {
			blockTexts.push({ blockIndex: i, text });
		}
	}
	return blockTexts;
}

function getBlockRangeText(block, blockRef, startPoint, endPoint, emittedTextSpans) {
	const segments = flattenPlainTextSegments(block, blockRef);
	if (!segments.some(segment => segment.type === 'text')) {
		return '';
	}

	const startIndex = startPoint?.ref
		? findBoundarySegmentIndex(segments, startPoint.ref, 'start')
		: findFirstTextSegmentIndex(segments);
	const endIndex = endPoint?.ref
		? findBoundarySegmentIndex(segments, endPoint.ref, 'end')
		: findLastTextSegmentIndex(segments);

	if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
		return '';
	}

	const parts = [];
	let pendingSeparator = '';
	for (let i = startIndex; i <= endIndex; i++) {
		const segment = segments[i];
		if (segment.type === 'separator') {
			pendingSeparator += segment.text;
			continue;
		}

		const text = getUnemittedSegmentText(
			segment,
			i === startIndex ? startPoint : null,
			i === endIndex ? endPoint : null,
			emittedTextSpans
		);
		if (!text) {
			continue;
		}

		if (parts.length && pendingSeparator) {
			parts.push(pendingSeparator);
		}
		pendingSeparator = '';
		parts.push(text);
	}
	return parts.join('');
}

function flattenPlainTextSegments(node, ref) {
	if (!node) {
		return [];
	}
	if (typeof node.text === 'string') {
		return [{ type: 'text', ref, text: node.text }];
	}
	if (!Array.isArray(node.content)) {
		return [];
	}

	const hasChildBlock = node.content.some(child => child && typeof child.text !== 'string');
	if (!hasChildBlock) {
		const segments = [];
		for (let i = 0; i < node.content.length; i++) {
			const child = node.content[i];
			if (child && typeof child.text === 'string') {
				segments.push({ type: 'text', ref: [...ref, i], text: child.text });
			}
		}
		return segments;
	}

	const segments = [];
	for (let i = 0; i < node.content.length; i++) {
		const child = node.content[i];
		if (!child || typeof child.text === 'string') {
			continue;
		}
		const childSegments = flattenPlainTextSegments(child, [...ref, i]);
		if (!childSegments.length) {
			continue;
		}
		if (segments.length) {
			segments.push({ type: 'separator', text: '\n' });
		}
		segments.push(...childSegments);
	}
	return segments;
}

function getUnemittedSegmentText(segment, startPoint, endPoint, emittedTextSpans) {
	const length = segment.text.length;
	if (!length) {
		return '';
	}

	let startOffset = sameRef(startPoint?.ref, segment.ref) && Number.isInteger(startPoint.offset)
		? startPoint.offset
		: 0;
	let endOffset = sameRef(endPoint?.ref, segment.ref) && Number.isInteger(endPoint.offset)
		? endPoint.offset
		: length - 1;

	startOffset = clamp(startOffset, 0, length);
	endOffset = clamp(endOffset, -1, length - 1);
	if (endOffset < startOffset) {
		return '';
	}

	const start = startOffset;
	const end = endOffset + 1;
	const key = segment.ref.join('.');
	const emitted = emittedTextSpans.get(key) || [];
	const intervals = subtractIntervals(start, end, emitted);
	if (!intervals.length) {
		return '';
	}

	addIntervals(emitted, intervals);
	emittedTextSpans.set(key, emitted);
	return intervals.map(([from, to]) => segment.text.slice(from, to)).join('');
}

function findBoundarySegmentIndex(segments, ref, edge) {
	let match = -1;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.type !== 'text') {
			continue;
		}
		if (sameRef(segment.ref, ref)) {
			return i;
		}
		if (startsWithRef(segment.ref, ref)) {
			match = i;
			if (edge === 'start') {
				return i;
			}
		}
	}
	return match;
}

function findFirstTextSegmentIndex(segments) {
	for (let i = 0; i < segments.length; i++) {
		if (segments[i].type === 'text') {
			return i;
		}
	}
	return -1;
}

function findLastTextSegmentIndex(segments) {
	for (let i = segments.length - 1; i >= 0; i--) {
		if (segments[i].type === 'text') {
			return i;
		}
	}
	return -1;
}

function subtractIntervals(start, end, emitted) {
	const intervals = [];
	let cursor = start;
	for (const [from, to] of emitted) {
		if (to <= cursor) {
			continue;
		}
		if (from >= end) {
			break;
		}
		if (from > cursor) {
			intervals.push([cursor, Math.min(from, end)]);
		}
		cursor = Math.max(cursor, to);
		if (cursor >= end) {
			break;
		}
	}
	if (cursor < end) {
		intervals.push([cursor, end]);
	}
	return intervals;
}

function addIntervals(target, intervals) {
	target.push(...intervals);
	target.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	let write = 0;
	for (const interval of target) {
		if (write === 0 || interval[0] > target[write - 1][1]) {
			target[write++] = interval;
		}
		else {
			target[write - 1][1] = Math.max(target[write - 1][1], interval[1]);
		}
	}
	target.length = write;
}

function startsWithRef(ref, prefix) {
	if (!Array.isArray(ref) || !Array.isArray(prefix) || prefix.length > ref.length) {
		return false;
	}
	for (let i = 0; i < prefix.length; i++) {
		if (ref[i] !== prefix[i]) {
			return false;
		}
	}
	return true;
}

function sameRef(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(value, max));
}

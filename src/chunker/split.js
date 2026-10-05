// Prefer paragraphs, then sentences, then whitespace. The final
// fallback cuts at a code-point boundary, keeping every chunk within maxSize.
const BREAKS = [/\n\n/gu, null, /\s+/gu];
let sentenceSegmenter;

export function* splitText(text, maxSize, minSize, overlap, limitEnd, preserveWhitespace = () => false) {
	let sentenceEnds;
	let sentenceStarts = [], overlapCursor = 0;
	let sentenceCursor = 0;
	let start = 0;
	let previousEnd = 0;
	while (start < text.length) {
		while (start < text.length && /\s/u.test(text[start]) && !preserveWhitespace(start)) start++;
		if (start === text.length) break;
		let end = codePointBoundary(text, Math.min(text.length, start + maxSize));
		if (limitEnd) end = codePointBoundary(text, limitEnd(start, end));
		let paragraphBreak = false;
		if (end < text.length) {
			// A boundary must include text, not just preserved indentation or newlines.
			let floor = Math.max(start + text.slice(start, end).search(/\S|$/u) + 1, start + minSize, previousEnd + 1);
			let remaining = text.length - start;
			for (let i = 0; i < BREAKS.length; i++) {
				// Balance all remaining parts within the token-limited window.
				// Paragraphs carry no overlap; denser windows must still make progress.
				let carry = i === 0 ? 0 : Math.min(overlap, end - start - 1);
				let parts = Math.ceil((remaining - carry) / (end - start - carry));
				let target = start + Math.ceil((remaining + (parts - 1) * carry) / parts);
				let offsets, first = 0;
				if (BREAKS[i]) {
					offsets = Array.from(text.slice(start, end).matchAll(BREAKS[i]), match => start + match.index + match[0].trimEnd().length);
				}
				else {
					// Segment the full text once, not a window with an artificial end.
					// Pin the locale rather than inherit the machine's default.
					sentenceSegmenter ??= new Intl.Segmenter('en', { granularity: 'sentence' });
					offsets = sentenceEnds ??= Array.from(sentenceSegmenter.segment(text), ({ index, segment }) => {
						sentenceStarts.push(index);
						return index + segment.trimEnd().length;
					});
					while (offsets[sentenceCursor] < floor) sentenceCursor++;
					first = sentenceCursor;
				}
				let boundary;
				for (let j = first; offsets[j] <= end; j++) {
					let offset = offsets[j];
					if (offset < floor) continue;
					// Let finer boundaries balance an undersized final paragraph.
					if (i === 0 && text.slice(offset).trim().length < minSize) continue;
					if (boundary === undefined || Math.abs(offset - target) <= Math.abs(boundary - target)) {
						boundary = offset;
					}
				}
				if (boundary !== undefined) { end = boundary; paragraphBreak = i === 0; break; }
			}
		}
		while (end > start && /\s/u.test(text[end - 1]) && !preserveWhitespace(end - 1)) end--;
		// Overlap followed by a long whitespace run must not emit the same text.
		if (end <= previousEnd) { start = previousEnd; continue; }
		// A tight budget can split indentation or blank lines into their own
		// slice. Advance past it without emitting an empty embedding passage.
		if (/\S/u.test(text.slice(start, end))) yield { start, end };
		previousEnd = end;
		if (end === text.length) break;
		let carry = paragraphBreak ? 0 : overlap;
		start = codePointBoundary(text, Math.max(start + 1, end - carry), true);
		if (carry && start < end) {
			// Prefer complete trailing sentences that fit the overlap allowance.
			while (sentenceStarts[overlapCursor] < start) overlapCursor++;
			if (sentenceStarts[overlapCursor] < end) start = sentenceStarts[overlapCursor];
			else {
				let space = text.slice(start, end).search(/\s/u);
				if (space >= 0) start += space + 1;
			}
		}
	}
}

function codePointBoundary(text, offset, roundUp = false) {
	return offset > 0 && offset < text.length
		&& /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset])
		? offset + (roundUp ? 1 : -1) : offset;
}

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { pdfAnchor, recoveredText } from './helpers.js';

const pdf = (text, rects) => ({
	metadata: { processor: { type: 'pdf' } },
	catalog: { outline: [], pages: [{ contentRange: [[0], [1]] }] },
	content: [{ type: 'paragraph', anchor: { pageRects: [[0, -100, -100, 100, 100]] },
		content: [{ text, anchor: { textMap: JSON.stringify(rects.map(rect => [0, 0, ...rect])) } }] }],
});

it('recovers a saved PDF position after a boundary glyph shifts slightly', () => {
	let original = pdf('AB', [[0, 0, 10, 1], [10, 0, 10, 1]]);
	let anchor = JSON.parse(JSON.stringify(getChunks(original)[0].anchor));
	let changed = pdf('AB', [[0, 0, 10, 1], [10.005, 0, 10.005, 1]]);
	assert.equal(recoveredText(changed, anchor), 'AB');
	assert.deepEqual(anchor, { pageRects: [[0, 0, 0, 10, 1]] });
	assert.deepEqual(getChunks(original)[0].anchor, anchor);
});

for (let [name, rect, expected] of [
	['zero-width boundary', [2, 0, 2, 1], 'ABC'],
	['partly overlapping', [1.5, 0, 2.5, 1], 'AB'],
	['fully contained', [1.25, 0, 1.75, 1], 'ABC'],
]) {
	it(`handles an adjacent ${name} glyph at a small chunk boundary`, () => {
		let structure = pdf('ABC', [[0, 0, 1, 1], [1, 0, 2, 1], rect]);
		let [chunk] = getChunks(structure, { maxSize: 2, minSize: 0, overlap: 0 });
		assert.equal(chunk.text, 'AB');
		assert.equal(recoveredText(structure, JSON.parse(JSON.stringify(chunk.anchor))), expected);
	});
}

for (let [edge, glyph] of [
	['left', shift => [-shift, 0, -shift, 1]],
	['right', shift => [1 + shift, 0, 1 + shift, 1]],
	['bottom', shift => [0, -shift, 1, -shift]],
	['top', shift => [0, 1 + shift, 1, 1 + shift]],
]) {
	it(`tolerates small shifts at the PDF rectangle's ${edge} edge only`, () => {
		let positions = [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }];
		// Include enough distant glyphs to exercise the spatial tree as well.
		let distant = Array.from({ length: 32 }, (_, i) => [20 + i, 20, 21 + i, 21]);
		for (let [shift, expected] of [[0.005, 'A'], [0.02, null]]) {
			let structure = pdf('A' + 'B'.repeat(distant.length), [glyph(shift), ...distant]);
			assert.equal(recoveredText(structure, pdfAnchor(positions)), expected);
		}
		assert.deepEqual(positions, [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }]);
	});
}

it('recovers surviving PDF text when separate saved rectangles become empty', () => {
	let rects = [[0, 0, 1, 1], [20, 0, 21, 1], [40, 0, 41, 1]];
	let anchor = JSON.parse(JSON.stringify(getChunks(pdf('ABC', rects))[0].anchor));
	assert.deepEqual(anchor, { pageRects: rects.map(rect => [0, ...rect]) });
	for (let text of ['AC', 'A', 'C', '']) {
		let changed = pdf(text, [...text].map(char => rects['ABC'.indexOf(char)]));
		assert.equal(recoveredText(changed, anchor), text || null);
	}
});

it('requires surviving text per page rather than per rectangle', () => {
	let a = [0, 0, 1, 1], b = [20, 0, 21, 1];
	let positions = [{ pageIndex: 0, rects: [a] }, { pageIndex: 0, rects: [b] }];
	assert.equal(recoveredText(pdf('AB', [a, b]), pdfAnchor(positions)), 'AB');
	assert.equal(recoveredText(pdf('A', [a]), pdfAnchor(positions)), 'A');
	assert.equal(recoveredText(pdf('B', [b]), pdfAnchor(positions)), 'B');
	assert.equal(recoveredText(pdf('A', [a]), pdfAnchor([positions[0], positions[0]])), 'A');
});

it('rejects a partly unresolved multi-page selection instead of returning one page', () => {
	let structure = pdf('A', [[0, 0, 1, 1]]);
	structure.content.push({ type: 'paragraph', content: [{ text: 'B', anchor: { textMap: '[[0,1,0,0,1,1]]' } }] });
	structure.catalog.pages = [{ contentRange: [[0], [1]] }, { contentRange: [[1], [2]] }];
	let positions = [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }, { pageIndex: 1, rects: [[20, 0, 21, 1]] }];
	assert.equal(recoveredText(structure, pdfAnchor(positions)), null);
	positions[1].rects = [[0, 0, 1, 1]];
	assert.equal(recoveredText(structure, pdfAnchor(positions)), 'A\n\nB');
});

it('recovers reordered pages within one text node in source order', () => {
	let text = ['A', 'B', 'C', 'D'].map(char => char.repeat(20)).join('');
	let structure = pdf(text, []);
	structure.content[0].content[0].anchor.textMap = JSON.stringify([2, 0, 2, 1].flatMap(page =>
		Array.from({ length: 20 }, (_, x) => [0, page, x, 0, x + 1, 1])));
	structure.catalog.pages = Array.from({ length: 3 }, () => ({ contentRange: [[0], [1]] }));
	let pageRects = [1, 2].map(page => [page, 0, 0, 20, 1]);
	let expected = 'A'.repeat(20) + ' ' + 'C'.repeat(20) + 'D'.repeat(20);
	assert.equal(recoveredText(structure, { pageRects }), expected);
	assert.equal(recoveredText(structure, { pageRects: [...pageRects].reverse() }), expected);
});

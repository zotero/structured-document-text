import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorPositions } from '../../src/chunker/index.js';
import { stringifyTextMap } from '../../src/pdf/text-map.js';
import { pdf, pdfBlock, dom, restore, recoveredText } from './helpers.js';

// One glyph per supplied rectangle; spaces between glyphs have no geometry.
function paragraph(rects, text = rects.map((_, i) => String.fromCharCode(65 + i)).join(' ')) {
	let block = pdfBlock(text);
	block.anchor.pageRects = [[0, Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])),
		Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))]];
	block.content[0].anchor.textMap = JSON.stringify(rects.map(rect => [0, 0, ...rect]));
	return block;
}

const twoLines = () => paragraph([[0, 20, 10, 30], [0, 0, 10, 10]]);

it('stores a paragraph region and restores its individual Reader lines', () => {
	let structure = pdf([twoLines()]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor, { pageRects: [[0, 0, 0, 10, 30]] });
	let saved = restore(anchor);
	assert.equal(recoveredText(restore(structure), saved), text);
	assert.deepEqual(getAnchorPositions(structure, saved), [{ pageIndex: 0, rects: [[0, 20, 10, 30], [0, 0, 10, 10]] }]);
});

it('removes decimal accumulation tails from saved anchors while retaining Reader geometry', () => {
	let block = pdfBlock('AB', 7);
	let bottom = -0.2 - 0.1, top = 10.1 + 0.2;
	block.content[0].anchor.textMap = JSON.stringify([[0, 7, 0.1, bottom, 0.6, top, 0.2, 0.3]]);
	let structure = pdf([block]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor, { pageRects: [[7, 0.1, -0.3, 0.6, 10.3]] });
	let saved = restore(anchor);
	assert.equal(recoveredText(structure, saved), text);
	assert.deepEqual(getAnchorPositions(structure, saved), [
		{ pageIndex: 7, rects: [[0.1, bottom, 0.1 + 0.2 + 0.3, top]] },
	]);
});

it('retains precise coordinates that are not decimal accumulation noise', () => {
	let rect = [0.123456789, -1.1234567, 10.23456789, 20.345678901];
	let structure = pdf([paragraph([rect], 'A')]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, [[0, ...rect]]);
	assert.equal(recoveredText(structure, restore(anchor)), text);
	assert.deepEqual(getAnchorPositions(structure, anchor), [{ pageIndex: 0, rects: [rect] }]);
});

it('skips distant block geometry and checks lines when a coarse block overlaps', () => {
	let distant = pdfBlock('Distant', 0, 100, 0, { flowClass: 'excluded' });
	Object.defineProperty(distant.content[0].anchor, 'textMap', { get() { throw Error('Decoded distant text'); } });
	let around = paragraph([[0, 40, 10, 50], [0, -20, 10, -10]], 'X Y');
	around.flowClass = 'excluded'; // Its block bounds contain the entire candidate.
	let structure = pdf([twoLines(), distant, around]);
	assert.deepEqual(getChunks(structure)[0].anchor.pageRects, [[0, 0, 0, 10, 30]]);
});

it('checks excluded lines and recovery tolerance before merging', () => {
	for (let rect of [[5, 15, 6, 16], [10.005, 15, 10.005, 16], [10.01, 15, 10.01, 16],
		[9, 15, 30, 16]]) { // The last rectangle intersects even though its glyph center does not.
		let omitted = paragraph([rect], 'X');
		omitted.flowClass = 'excluded';
		let structure = pdf([twoLines(), omitted]);
		let { anchor, text } = getChunks(structure)[0];
		assert.equal(anchor.pageRects.length, 2, `Obstacle ${rect}`);
		assert.equal(recoveredText(structure, anchor), text);
	}
});

it('checks decoded line edges that extend beyond the source block bounds', () => {
	let tinyWidths = Array.from({ length: 100 }, () => [0.01, 0.25, 0.01]).flat();
	for (let [selected, run] of [
		[twoLines(), [0, 0, 10.1, 15, 12.1, 16]],
		[paragraph([[0, 14, 10, 24], [0, 3, 10, 13]]), [2, 0, 0.25, 0.75, 1.25, 2.25, 1.5]],
		[paragraph([[30.99, 20, 40, 30], [30.99, 0, 40, 10]]), [0, 0, 0.75, 15, 27.75, 16, ...tinyWidths]],
	]) {
		let omitted = paragraph([run.slice(2, 6)], 'X'.repeat(Math.max(1, run.length - 6)));
		omitted.flowClass = 'excluded';
		// Exercise ordinary edge rounding, vertical origin/width rounding,
		// and accumulated error from widths that the existing encoder clamps.
		omitted.content[0].anchor.textMap = stringifyTextMap([run]);
		let structure = pdf([selected, omitted]);
		let { anchor, text } = getChunks(structure)[0];
		assert.equal(anchor.pageRects.length, 2);
		assert.equal(recoveredText(structure, anchor), text);
	}
});

it('consolidates a multiline list item and restores its Reader lines', () => {
	let item = twoLines();
	item.type = 'listitem';
	let structure = pdf([item]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, [[0, 0, 0, 10, 30]]);
	assert.equal(recoveredText(structure, anchor), text);
	assert.deepEqual(getAnchorPositions(structure, anchor), [{ pageIndex: 0, rects: [[0, 20, 10, 30], [0, 0, 10, 10]] }]);
});

it('consolidates nearby raised fragments only when the combined region is clear', () => {
	let selected = paragraph([[0, 0, 10, 10], [11, 8, 13, 12]]);
	let structure = pdf([selected]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, [[0, 0, 0, 13, 12]]);
	assert.equal(recoveredText(structure, anchor), text);
	assert.deepEqual(getAnchorPositions(structure, anchor), [{ pageIndex: 0, rects: [[0, 0, 10, 10], [11, 8, 13, 12]] }]);
	let omitted = paragraph([[12, 0, 13, 1]], 'X');
	omitted.flowClass = 'excluded';
	structure = pdf([selected, omitted]);
	anchor = getChunks(structure)[0].anchor;
	assert.equal(anchor.pageRects.length, 2);
	assert.equal(recoveredText(structure, anchor), text);
});

it('consolidates text after a raised marker and the line below the entire row', () => {
	let rects = [[0, 20, 10, 30], [10.5, 26, 12.5, 32], [16.5, 20, 26.5, 30], [0, 0, 10, 10]];
	let structure = pdf([paragraph(rects)]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, [[0, 0, 0, 26.5, 32]]);
	assert.equal(recoveredText(structure, anchor), text);
	assert.deepEqual(getAnchorPositions(structure, anchor), [{ pageIndex: 0, rects }]);
	// A wider same-line gap, or a next line outside the row, stays separate.
	for (let [index, rect, regions] of [[2, [18.5, 20, 28.5, 30], 3], [3, [30, 0, 40, 10], 2]]) {
		let changed = rects.with(index, rect);
		assert.equal(getChunks(pdf([paragraph(changed)]))[0].anchor.pageRects.length, regions, `Fragment ${rect}`);
	}
});

it('keeps a paragraph crossing pages separate even when its lines otherwise follow', () => {
	let block = twoLines();
	block.anchor.pageRects = [[0, 0, 20, 10, 30], [1, 0, 0, 10, 10]];
	block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 20, 10, 30], [0, 1, 0, 0, 10, 10]]);
	let structure = pdf([block]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, block.anchor.pageRects);
	assert.equal(recoveredText(structure, anchor), text);
	assert.deepEqual(getAnchorPositions(structure, anchor), [
		{ pageIndex: 0, rects: [[0, 20, 10, 30]] }, { pageIndex: 1, rects: [[0, 0, 10, 10]] },
	]);
});

it('reports newly extracted text inside a saved paragraph region', () => {
	let { anchor } = getChunks(pdf([twoLines()]))[0];
	let newlyRecognized = paragraph([[5, 15, 6, 16]], 'X');
	newlyRecognized.flowClass = 'excluded';
	let changed = pdf([twoLines(), newlyRecognized]);
	// Recovery reflects the supplied extraction, not the old chunk's text/policy.
	assert.equal(recoveredText(changed, anchor), 'A B\n\nX');
});

it('treats an unselected part of the same line as an obstacle', () => {
	let structure = pdf([paragraph([[0, 20, 10, 30], [0, 0, 4, 10], [8, 0, 9, 10]], 'ABX')]);
	let chunk = getChunks(structure, { maxSize: 2, minSize: 0, overlap: 0 })[0];
	assert.equal(chunk.text, 'AB');
	assert.equal(chunk.anchor.pageRects.length, 2);
	assert.equal(recoveredText(structure, chunk.anchor), 'AB');
});

it('checks the entire growing region and continues after a rejected merge', () => {
	let selected = paragraph([[0, 60, 10.1 + 0.2, 70], [0, 40, 4, 50], [0, 20, 4, 30], [0, 0, 4, 10]]);
	let omitted = paragraph([[8, 22, 9, 23]], 'X');
	omitted.flowClass = 'excluded';
	let structure = pdf([selected, omitted]);
	let { anchor, text } = getChunks(structure)[0];
	assert.deepEqual(anchor.pageRects, [[0, 0, 40, 10.3, 70], [0, 0, 0, 4, 30]]);
	assert.equal(recoveredText(structure, anchor), text);
});

it('keeps uncertain geometry separate, using block bounds when available', () => {
	for (let bounded of [true, false]) {
		let omitted = paragraph([[5, 15, 6, 16]], 'X');
		omitted.flowClass = 'excluded';
		delete omitted.content[0].anchor;
		if (!bounded) delete omitted.anchor;
		let structure = pdf([twoLines(), omitted]);
		assert.equal(getChunks(structure)[0].anchor.pageRects.length, 2);
	}
});

it('keeps separate paragraphs, columns, and headings precise', () => {
	let a = paragraph([[0, 20, 10, 30]], 'A');
	let b = paragraph([[0, 0, 10, 10]], 'B');
	assert.equal(getChunks(pdf([a, b]))[0].anchor.pageRects.length, 2);
	for (let rect of [[20, 0, 30, 10], [200, 20, 210, 30]]) {
		let columns = paragraph([[0, 20, 10, 30], rect]);
		assert.equal(getChunks(pdf([columns]))[0].anchor.pageRects.length, 2);
	}
	let heading = twoLines();
	heading.type = 'heading';
	assert.equal(getChunks(pdf([heading]))[0].anchor.pageRects.length, 2);
});

it('copies DOM selectors without claiming successful text recovery', () => {
	let structure = dom(['Body'], 'snapshot');
	let anchor = { selectors: [{ type: 'CssSelector', value: '#absent',
		refinedBy: { type: 'TextPositionSelector', start: 1, end: 3 } }] };
	let positions = getAnchorPositions(structure, anchor);
	assert.deepEqual(positions, anchor.selectors);
	assert.equal(recoveredText(structure, anchor), null);
	positions[0].refinedBy.start = 2;
	positions[0].value = '#changed';
	assert.equal(anchor.selectors[0].refinedBy.start, 1);
	assert.equal(anchor.selectors[0].value, '#absent');
});

it('rejects invalid anchor components without returning a partial result', () => {
	let structure = pdf([pdfBlock('Body')]);
	let good = getChunks(structure)[0].anchor;
	for (let anchor of [null, { pageRects: [] }, { ...good, selectors: [] },
		{ pageRects: [...good.pageRects, [0, NaN, 0, 1, 1]] },
		{ pageRects: [...good.pageRects, [2, 0, 0, 1, 1]] }]) {
		assert.equal(recoveredText(structure, anchor), null);
		assert.equal(getAnchorPositions(structure, anchor), null);
	}
	structure = dom(['Body'], 'snapshot');
	good = getChunks(structure)[0].anchor;
	let missing = { type: 'TextPositionSelector', start: 100, end: 104 };
	assert.equal(recoveredText(structure, { selectors: [...good.selectors, missing] }), null);
	for (let selector of [null, { type: 'FragmentSelector', value: 'epubcfi(/6/2!/4/2)' },
		{ type: 'TextPositionSelector', start: -1, end: 4 }]) {
		let anchor = { selectors: [...good.selectors, selector] };
		assert.equal(recoveredText(structure, anchor), null);
		assert.equal(getAnchorPositions(structure, anchor), null);
	}
});

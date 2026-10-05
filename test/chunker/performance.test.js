import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { getDocument } from '../../src/chunker/document.js';
import { PDFPositionMapper } from '../../src/chunker/pdf.js';
import { pdf, pdfBlock, pdfAnchor, dom, recoveredText } from './helpers.js';

for (let valid of [true, false]) it(`decodes an oversized ${valid ? 'valid' : 'invalid'} PDF node once across all its chunks`, t => {
	let count = 100001;
	let textMap = JSON.stringify([[0, 0, 0, 0, count, 1, ...new Array(count - (valid ? 0 : 1)).fill(1)]]);
	let decodes = 0;
	let parse = JSON.parse;
	t.mock.method(JSON, 'parse', (...args) => {
		if (args[0] === textMap) decodes++;
		return parse(...args);
	});
	let structure = pdf([{ type: 'paragraph', content: [{ text: 'a'.repeat(count), anchor: { textMap } }] }]);
	let chunks = getChunks(structure);
	assert.ok(chunks.length > 30);
	assert.equal(decodes, 1);
	for (let chunk of chunks) {
		assert.equal(recoveredText(structure, chunk.anchor), valid ? chunk.text : null);
		if (!valid) assert.equal(chunk.anchor, null);
	}
	getChunks(structure);
	assert.equal(decodes, 1);
});

it('does not cache unexpected PDF decoding errors', () => {
	let structure = pdf([pdfBlock('A')]);
	let failure = new Error('Unexpected geometry access failure');
	let node = structure.content[0].content[0];
	Object.defineProperty(node.anchor, 'textMap', { get() { throw failure; } });
	let mapper = new PDFPositionMapper(getDocument(structure));
	for (let i = 0; i < 2; i++) assert.throws(() => mapper._characters(node), error => error === failure);
});

it('does not scan each PDF node for unrelated anchor pages', () => {
	let count = 32;
	let structure = pdf(Array.from({ length: count }, (_, page) => pdfBlock('A', page)));
	structure.catalog.pages = Array.from({ length: count }, (_, page) => ({ contentRange: [[page], [page + 1]] }));
	let document = getDocument(structure), mapper = new PDFPositionMapper(document);
	let positions = Array.from({ length: count }, (_, pageIndex) => ({ pageIndex, rects: [[0, 0, 1, 1]] }));
	mapper.toSpans(positions);
	let pageChecks = 0;
	for (let { node } of document.entries) {
		let glyph = mapper._characters(node)[0], page = glyph[4];
		Object.defineProperty(glyph, 4, { get() { pageChecks++; return page; } });
	}
	assert.equal(mapper.toSpans(positions).length, count);
	assert.ok(pageChecks <= 2 * count, `Scanned unrelated pages ${pageChecks} times`);
});

it('recovers a selection containing 150,000 DOM text nodes', () => {
	let count = 150000;
	let structure = dom([''], 'snapshot');
	structure.content[0].content = Array.from({ length: count }, (_, stream) => ({ text: 'a', anchor: { stream } }));
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 0, end: count }] }), 'a'.repeat(count));
});

it('recovers a PDF selection with 200,000 overlapping rectangles', () => {
	let structure = pdf([pdfBlock('A')]);
	let rects = Array.from({ length: 200000 }, () => [0, 0, 1, 1]);
	assert.equal(recoveredText(structure, pdfAnchor([{ pageIndex: 0, rects }])), 'A');
});

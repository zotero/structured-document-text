import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorPositions } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { PDFPositionMapper } from '../../src/chunker/pdf.js';
import { getDocument } from '../../src/chunker/document.js';
import { noOverlap, paragraph, document, pdf, pdfBlock, pdfAnchor, roundTrip, restore, recoveredText } from './helpers.js';

describe('complete PDF positions', () => {
	it('preserves three pages while excluding running headers and footers', () => {
		let structure = pdf([0, 1, 2].flatMap(page => [
			pdfBlock('Header', page, 0, 100, { flowClass: 'excluded' }),
			pdfBlock(`Page ${page + 1} body`, page, 0, 50),
			pdfBlock('Footer', page, 0, 0, { flowClass: 'excluded' }),
		]));
		let [{ chunk, positions }] = roundTrip(structure);
		assert.equal(chunk.text, 'Page 1 body\n\nPage 2 body\n\nPage 3 body');
		assert.deepEqual(positions.map(p => p.pageIndex), [0, 1, 2]);
		for (let position of positions) {
			assert.deepEqual(Object.keys(position).sort(), ['pageIndex', 'rects']);
			assert.deepEqual(position.rects, [[0, 50, 11, 51]]);
		}
		// Recovery deliberately ignores newly changed indexability flags.
		let changed = restore(structure);
		for (let block of changed.content) block.flowClass = 'excluded';
		assert.equal(recoveredText(changed, pdfAnchor(restore(positions))), chunk.text);
	});

	it('merges a continuous line across inline formatting and whitespace', () => {
		let block = pdfBlock('First');
		block.content.push({ text: ' ' }, { ...pdfBlock('Second', 0, 6).content[0], bold: true });
		let structure = pdf([block]);
		let original = restore(structure);
		let [{ positions }] = roundTrip(structure);
		assert.deepEqual(positions, [{ pageIndex: 0, rects: [[0, 0, 12, 1]] }]);
		// Neither source geometry nor cached glyph rectangles may be expanded.
		assert.deepEqual(structure, original);
		assert.deepEqual(getAnchorPositions(structure, getChunks(structure, { maxSize: 5, minSize: 0, overlap: 0 })[0].anchor),
			[{ pageIndex: 0, rects: [[0, 0, 5, 1]] }]);
	});

	it('keeps omitted characters separate even when the geometric gap is small', () => {
		for (let inline of [false, true]) {
			let block = pdfBlock('ABXCD');
			if (inline) block.content = [pdfBlock('AB').content[0], pdfBlock('X', 0, 2).content[0], pdfBlock('CD', 0, 3).content[0]];
			let structure = pdf([block]);
			let doc = getDocument(structure);
			let spans = inline
				? [0, 2].map(index => ({ entry: doc.entries[index], start: 0, end: 2 }))
				: [{ entry: doc.entries[0], start: 0, end: 2 }, { entry: doc.entries[0], start: 3, end: 5 }];
			let positions = new PDFPositionMapper(doc).toPositions(spans);
			assert.deepEqual(positions, [{ pageIndex: 0, rects: [[0, 0, 2, 1], [3, 0, 5, 1]] }]);
			assert.equal(recoveredText(structure, pdfAnchor(positions)), 'AB CD');
		}
	});

	it('keeps selected columns separate even within one text node', () => {
		for (let text of ['ABCD', 'AB CD']) {
			let block = pdfBlock(text);
			block.content[0].anchor.textMap = JSON.stringify([0, 1, 20, 21].map(x => [0, 0, x, 0, x + 1, 10]));
			assert.deepEqual(roundTrip(pdf([block]))[0].positions[0].rects, [[0, 0, 2, 10], [20, 0, 22, 10]]);
		}
	});

	it('merges justified word spaces within and between inline text nodes', () => {
		for (let inline of [false, true]) {
			let block = pdfBlock('AB CD');
			let runs = [0, 1, 12, 13].map(x => [0, 0, x, 0, x + 1, 10]);
			block.content[0].anchor.textMap = JSON.stringify(runs);
			if (inline) block.content = [
				{ text: 'AB', anchor: { textMap: JSON.stringify(runs.slice(0, 2)) } },
				{ text: ' ' },
				{ text: 'CD', anchor: { textMap: JSON.stringify(runs.slice(2)) } },
			];
			assert.deepEqual(roundTrip(pdf([block]))[0].positions[0].rects, [[0, 0, 14, 10]]);
		}
	});

	it('does not merge over omitted symbols between selected words', () => {
		let block = pdfBlock('A B');
		block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 10], [0, 0, 9, 0, 10, 10]]);
		let omitted = pdfBlock('X', 0, 4, 0, { reference: true });
		let structure = pdf([block, omitted]);
		assert.deepEqual(roundTrip(structure)[0].positions[0].rects, [[0, 0, 1, 10], [9, 0, 10, 10]]);
		// Included symbols are not barriers.
		let included = restore(structure);
		delete included.content[1].reference;
		assert.deepEqual(getAnchorPositions(included, getChunks(included)[0].anchor)[0].rects,
			[[0, 0, 10, 10], [4, 0, 5, 1]]);
	});

	it('finds tall omitted geometry behind shorter boxes in the page index', () => {
		let block = pdfBlock('A B');
		block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 10], [0, 0, 9, 0, 10, 10]]);
		let omitted = pdfBlock('X', 0, 4, -100, { flowClass: 'excluded' });
		omitted.anchor.pageRects = [[0, 4, -100, 5, 100]];
		omitted.content[0].anchor.textMap = JSON.stringify([[0, 0, 4, -100, 5, 100]]);
		let unrelated = [-50, -20, -2].map(y => pdfBlock('Y', 0, 4, y, { flowClass: 'excluded' }));
		assert.deepEqual(roundTrip(pdf([block, omitted, ...unrelated]))[0].positions[0].rects,
			[[0, 0, 1, 10], [9, 0, 10, 10]]);
	});

	it('uses character geometry for omitted blocks without page bounds', () => {
		let block = pdfBlock('A B');
		block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 10], [0, 0, 9, 0, 10, 10]]);
		let omitted = pdfBlock('X', 0, 4, 0, { flowClass: 'excluded' });
		delete omitted.anchor;
		assert.deepEqual(roundTrip(pdf([block, omitted]))[0].positions[0].rects,
			[[0, 0, 1, 10], [9, 0, 10, 10]]);
	});

	it('does not cover unselected characters within a partly selected block', () => {
		for (let inline of [false, true]) {
			let block = pdfBlock('ABC');
			let runs = [0, 8, 4].map(x => [0, 0, x, 0, x + 3, 10]);
			block.content = inline
				? ['AB', 'C'].map((text, i) => ({ text, anchor: { textMap: JSON.stringify(i ? runs.slice(2) : runs.slice(0, 2)) } }))
				: [{ text: 'ABC', anchor: { textMap: JSON.stringify(runs) } }];
			let [first] = roundTrip(pdf([block]), { maxSize: 2, minSize: 0, overlap: 0 });
			assert.equal(first.chunk.text, 'AB');
			assert.deepEqual(first.positions[0].rects, [[0, 0, 3, 10], [8, 0, 11, 10]]);
		}
	});

	it('preserves direction boundaries in mixed-direction selections', () => {
		let block = pdfBlock('aאב');
		block.content[0].anchor.textMap = JSON.stringify([
			[0, 0, 0, 0, 3, 10], [8, 0, 8, 0, 11, 10], [8, 0, 4, 0, 7, 10],
		]);
		let structure = pdf([block]);
		assert.deepEqual(roundTrip(structure)[0].positions[0].rects, [[0, 0, 3, 10], [4, 0, 11, 10]]);
		assert.equal(roundTrip(structure, { maxSize: 2, minSize: 0, overlap: 0 })[0].chunk.text, 'aא');
	});

	it('keeps a drop cap from expanding its line over following lines', () => {
		let block = pdfBlock('Tabcd efgh ijkl');
		block.content[0].anchor.textMap = JSON.stringify([
			[0, 0, 0, 0, 2, 30],
			...[20, 10, 0].flatMap(y => Array.from({ length: 4 }, (_, i) => [0, 0, 2 + 3 * i, y, 5 + 3 * i, y + 10])),
		]);
		let [first] = roundTrip(pdf([block]), { maxSize: 5, minSize: 0, overlap: 0 });
		assert.equal(first.chunk.text, 'Tabcd');
		assert.deepEqual(first.positions[0].rects, [[0, 0, 2, 30], [2, 20, 14, 30]]);
	});

	it('splits slanted lines before their rectangles cover adjacent text', () => {
		for (let vertical of [false, true]) {
			let block = pdfBlock('a'.repeat(40) + ' ' + 'b'.repeat(40));
			block.anchor.pageRects = [vertical ? [0, -12, 0, 25.6, 200] : [0, 0, -12, 200, 25.6]];
			block.content[0].anchor.textMap = JSON.stringify([0, -12].flatMap(base =>
				Array.from({ length: 40 }, (_, i) => {
					let rect = [5 * i, base + 0.4 * i, 5 * i + 5, base + 0.4 * i + 10];
					return [vertical ? 2 : 0, 0, ...(vertical ? [rect[1], rect[0], rect[3], rect[2]] : rect)];
				})));
			let chunks = roundTrip(pdf([block]), { maxSize: 40, minSize: 0, overlap: 0 });
			assert.deepEqual(chunks.map(({ chunk }) => chunk.text), ['a'.repeat(40), 'b'.repeat(40)]);
			for (let { positions } of chunks) {
				assert.ok(positions[0].rects.length > 1);
				assert.ok(positions[0].rects.length < 40);
			}
		}
	});

	it('merges vertical lines along their writing axis and separates orientations', () => {
		for (let reverse of [false, true]) {
			let block = pdfBlock('ABCD');
			block.content[0].anchor.textMap = JSON.stringify(Array.from({ length: 4 }, (_, i) => {
				let y = reverse ? 3 - i : i;
				return [2, 0, 0, y, 10, y + 1];
			}));
			assert.deepEqual(roundTrip(pdf([block]))[0].positions[0].rects, [[0, 0, 10, 4]]);
		}
		let block = pdfBlock('AB');
		block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 1], [2, 0, 1, 0, 2, 1]]);
		assert.deepEqual(roundTrip(pdf([block]))[0].positions[0].rects, [[0, 0, 1, 1], [1, 0, 2, 1]]);
	});

	it('preserves a gap inside a text node and deduplicates overlapping source coverage', () => {
		let structure = pdf([pdfBlock('abc OMIT xyz')]);
		let positions = [{ pageIndex: 0, rects: [[0, 0, 3, 1], [9, 0, 12, 1]] }];
		assert.equal(recoveredText(structure, pdfAnchor(positions)), 'abc xyz');
		assert.equal(recoveredText(structure, pdfAnchor([...positions, ...positions])), 'abc xyz');
	});

	it('handles partial blocks and repeats at different source locations', () => {
		let structure = pdf([pdfBlock('Repeat Repeat Repeat Repeat')]);
		let chunks = roundTrip(structure, { maxSize: 13, minSize: 0, overlap: 0 });
		assert.ok(chunks.length > 1);
		assert.equal(recoveredText(structure, pdfAnchor(chunks.flatMap(p => p.positions))), 'Repeat Repeat Repeat Repeat');
	});

	it('rejects legacy position fields, missing pages and invalid anchor geometry', () => {
		let structure = pdf([pdfBlock('First', 0), pdfBlock('Second', 1)]);
		let [{ anchor }] = roundTrip(structure);
		assert.equal(recoveredText(structure, { ...anchor, nextPageRects: [[0, 0, 1, 1]] }), null);
		assert.equal(recoveredText(structure, { ...anchor, nextPageIndex: 7 }), null);
		assert.equal(recoveredText(structure, { pageRects: [...anchor.pageRects, [2, 0, 0, 1, 1]] }), null);
		assert.equal(recoveredText(structure, { pageRects: [[0, 0, 0, NaN, 1]] }), null);
	});

	it('omits PDF text without text-node maps instead of borrowing rectangles', () => {
		let block = paragraph('Whole block with no character geometry', { anchor: { pageRects: [[0, 0, 0, 20, 10]] } });
		let structure = pdf([block]);
		for (let options of [undefined, { maxSize: 12, minSize: 0, overlap: 0 }]) {
			assert.deepEqual(getChunks(structure, options), []);
			assert.deepEqual(getTextChunks(structure, options), []);
		}
		let missing = document([paragraph('No geometry')]);
		assert.deepEqual(getChunks(missing), []);
		let nodeRects = restore(structure);
		nodeRects.content[0].content[0].anchor = block.anchor;
		assert.deepEqual(getChunks(nodeRects), []);
	});

	it('does not substitute a block textMap for a missing text-node map', () => {
		let block = paragraph('AB', { anchor: { textMap: JSON.stringify([[0, 0, 0, 0, 2, 1, 1, 1]]) } });
		let structure = pdf([block]);
		assert.deepEqual(getChunks(structure), []);
		assert.deepEqual(getTextChunks(structure), []);
	});

	it('keeps text and isolates invalid PDF geometry to the affected chunk', () => {
		for (let textMap of [
			'[]', '{broken', '{}', '[[0]]',
			'[[0,0,0,0,1,1]]', // Too few glyphs.
			'[[0,0,0,0,3,1,1,1,1]]', // Too many glyphs.
			'[[0,-1,0,0,2,1,1,1]]', // Negative page.
			'[[0,0.5,0,0,2,1,1,1]]', // Fractional page.
			'[[0,0,0,0,2,1,-1,1]]', // Inverted advance.
			'[[0,0,0,2,2,1,1,1]]', // Inverted horizontal cross-axis.
			'[[2,0,2,0,1,2,1,1]]', // Inverted vertical cross-axis.
			'[[0,0,0,0,2,1e400,1,1]]', // Non-finite horizontal bounds.
			'[[2,0,-1e400,0,1,2,1,1]]', // Non-finite vertical bounds.
		]) {
			let broken = pdfBlock('AB');
			broken.content[0].anchor.textMap = textMap;
			let structure = pdf([pdfBlock('Before'), broken, pdfBlock('After', 0, 0, 10)]);
			structure.catalog.outline = structure.content.map((_, i) => ({ title: `Section ${i}`, ref: [i] }));
			let chunks = getChunks(structure, noOverlap);
			assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, noOverlap));
			assert.equal(chunks.length, 3);
			assert.equal(recoveredText(structure, chunks[0].anchor), 'Before');
			assert.equal(chunks[1].anchor, null);
			assert.equal(recoveredText(structure, chunks[2].anchor), 'After');
		}
	});

	it('does not swallow programming errors while producing positions', t => {
		let structure = pdf([pdfBlock('Body')]);
		let failure = new TypeError('Unexpected mapper failure');
		t.mock.method(PDFPositionMapper.prototype, 'toAnchor', () => { throw failure; });
		assert.equal(getTextChunks(structure)[0].text, 'Body');
		assert.throws(() => getChunks(structure), error => error === failure);
	});

	it('filters unmapped PDF text before sizing and preserves word separation', () => {
		let block = pdfBlock('First');
		block.content.push({ text: ' \n\t' }, { text: 'Missing '.repeat(1000) }, { text: ' ' },
			pdfBlock('Second', 0, 20).content[0]);
		let structure = pdf([block, paragraph('Missing block'), pdfBlock('Third', 0, 0, 10)]);
		let [{ chunk }] = roundTrip(structure, noOverlap);
		assert.equal(chunk.text, 'First Second\n\nThird');
		let { anchor, ...textChunk } = chunk;
		assert.deepEqual(getTextChunks(structure, noOverlap), [textChunk]);
	});

	it('does not decode excluded PDF text when generating a single-line anchor', () => {
		let excluded = pdfBlock('Excluded', 0, 20, 0, { flowClass: 'excluded' });
		Object.defineProperty(excluded.content[0].anchor, 'textMap', { get() { throw Error('Decoded excluded text'); } });
		let structure = pdf([pdfBlock('AB'), excluded]);
		assert.deepEqual(getChunks(structure)[0].anchor, { pageRects: [[0, 0, 0, 2, 1]] });
	});

	it('recovers from new block segmentation, and explicitly fails when source geometry is absent', () => {
		let original = pdf([pdfBlock('First Second')]);
		let [{ positions }] = roundTrip(original);
		let changed = pdf([pdfBlock('First', 0, 0), pdfBlock('Second', 0, 6)]);
		assert.equal(recoveredText(changed, pdfAnchor(positions)), 'First\n\nSecond');
		assert.equal(recoveredText(pdf([paragraph('First Second')]), pdfAnchor(positions)), null);
	});
});

it('keeps every page when one PDF text node itself crosses three pages', () => {
	let block = pdfBlock('ABC');
	block.content[0].anchor.textMap = JSON.stringify([0, 1, 2].map(page => [0, page, 0, 0, 1, 1]));
	block.anchor.pageRects = [0, 1, 2].map(page => [page, 0, 0, 1, 1]);
	let [{ positions }] = roundTrip(pdf([block]));
	assert.deepEqual(positions.map(position => position.pageIndex), [0, 1, 2]);
});

it('locates partial chunks on the correct pages of a single text node', () => {
	let block = pdfBlock('abcdefghij');
	block.anchor.pageRects = [[0, 0, 0, 5, 1], [1, 0, 0, 5, 1]];
	block.content[0].anchor.textMap = JSON.stringify(Array.from({ length: 10 }, (_, i) => [0, Math.floor(i / 5), i % 5, 0, i % 5 + 1, 1]));
	let chunks = roundTrip(pdf([block]), { maxSize: 5, minSize: 0, overlap: 0 });
	assert.deepEqual(chunks.map(({ chunk, positions }) => [chunk.text, positions[0].pageIndex]), [['abcde', 0], ['fghij', 1]]);
});

it('does not recover text from whole-block PDF boxes without character geometry', () => {
	let block = paragraph('Whole block', { anchor: { pageRects: [[0, 0, 0, 10, 1], [1, 0, 0, 10, 1]] } });
	let structure = pdf([block]);
	let positions = block.anchor.pageRects.map(([pageIndex, ...rect]) => ({ pageIndex, rects: [rect] }));
	assert.equal(recoveredText(structure, pdfAnchor(positions)), null);
});

it('keeps large gaps separate without claiming exact recovery of overlaid text', () => {
	let block = pdfBlock('AB');
	block.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 10], [0, 0, 9, 0, 10, 10]]);
	assert.deepEqual(roundTrip(pdf([block]))[0].positions[0].rects, [[0, 0, 1, 10], [9, 0, 10, 10]]);
	let omitted = pdfBlock('X', 0, 4, 0, { flowClass: 'excluded' });
	omitted.content[0].anchor.textMap = JSON.stringify([[0, 0, 4, 0, 5, 10]]);
	assert.deepEqual(roundTrip(pdf([block, omitted]))[0].positions[0].rects, [[0, 0, 1, 10], [9, 0, 10, 10]]);
	let overlaid = restore(omitted);
	overlaid.content[0].anchor.textMap = JSON.stringify([[0, 0, 0, 0, 1, 10]]);
	let structure = pdf([block, overlaid]);
	let anchor = getChunks(structure)[0].anchor;
	assert.deepEqual(anchor.pageRects, [[0, 0, 0, 1, 10], [0, 9, 0, 10, 10]]);
	assert.equal(recoveredText(structure, anchor), 'AB\n\nX');
});

it('merges RTL and uneven-height PDF glyphs into a single line rectangle', () => {
	for (let rtl of [false, true]) {
		let text = 'א'.repeat(40);
		let block = pdfBlock(text);
		block.content[0].anchor.textMap = JSON.stringify(Array.from(text, (_, i) => {
			let x = rtl ? 39 - i : i;
			let y = i % 3 / 10;
			return [rtl ? 8 : 0, 0, x, y, x + 1, y + 10];
		}));
		let [{ positions }] = roundTrip(pdf([block]));
		assert.deepEqual(positions[0].rects, [[0, 0, 40, 10.2]]);
	}
});

it('keeps closely spaced PDF lines separate, including at chunk boundaries', () => {
	let block = pdfBlock('A'.repeat(40));
	block.content[0].anchor.textMap = JSON.stringify(Array.from({ length: 40 }, (_, i) => {
		let x = i % 20;
		let y = Math.floor(i / 20) * 6 + i % 2 / 10;
		return [0, 0, x, y, x + 1, y + 10];
	}));
	let structure = pdf([block]);
	let [{ positions }] = roundTrip(structure);
	assert.deepEqual(positions[0].rects, [[0, 0, 20, 10.1], [0, 6, 20, 16.1]]);
	assert.deepEqual(roundTrip(structure, { maxSize: 20, minSize: 0, overlap: 0 })
		.map(({ positions }) => positions[0].rects), [[[0, 0, 20, 10.1]], [[0, 6, 20, 16.1]]]);
});

it('does not decode the following PDF block at an exclusive page boundary', () => {
	let structure = pdf([pdfBlock('A', 0), pdfBlock('B', 1)]);
	structure.catalog.pages = [{ contentRange: [[0], [1]] }, { contentRange: [[1], [2]] }];
	let anchor = structure.content[1].content[0].anchor;
	Object.defineProperty(anchor, 'textMap', { get() { throw Error('Decoded another page'); } });
	assert.equal(recoveredText(structure, pdfAnchor([{ pageIndex: 0, rects: [[0, 0, 1, 1]] }])), 'A');
});

it('maps PDF text offsets across omitted spaces and mapped NBSP and CR glyphs', () => {
	let block = pdfBlock('A \n\tB\u00a0C\rD');
	block.content[0].anchor.textMap = '[[0,0,0,0,6,1,1,1,1,1,1,1]]';
	let structure = pdf([block]);
	assert.deepEqual(roundTrip(structure)[0].positions, [{ pageIndex: 0, rects: [[0, 0, 6, 1]] }]);
	assert.equal(recoveredText(structure, pdfAnchor([{ pageIndex: 0, rects: [[3, 0, 4, 1]] }])), 'C');
	assert.equal(recoveredText(structure, pdfAnchor([{ pageIndex: 0, rects: [[5, 0, 6, 1]] }])), 'D');
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { iterateChunks } from '../../src/chunker/chunks.js';
import { getDocument, readingOrder } from '../../src/chunker/document.js';
import { discoverFixtures } from '../helpers.js';
import { pdf, pdfBlock, restore, recoveredText } from './helpers.js';

const fixtures = discoverFixtures();
const roomy = { maxSize: 2000, minSize: 0, overlap: 0 };
const aux = (text, page, y, type = 'caption') => pdfBlock(text, page, 0, y, { type, flowClass: 'auxiliary' });
const pages = chunk => [...new Set(chunk.anchor.pageRects.map(rect => rect[0]))].sort();
function link(structure, first, next) {
	structure.content[first].nextPart = [next];
	structure.content[next].previousPart = [first];
}
// Every chunk reads back as it was cut, and the text-only cut agrees.
function cut(structure, options = roomy) {
	let chunks = getChunks(structure, options);
	assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, options));
	for (let chunk of chunks) assert.equal(recoveredText(restore(structure), restore(chunk.anchor)), chunk.text);
	return chunks;
}

describe('folding auxiliary text', () => {
	it('places a caption between the paragraphs it sits between', () => {
		let structure = pdf([pdfBlock('First paragraph.', 0, 0, 10), aux('Figure 1. An owl.', 0, 5), pdfBlock('Second paragraph.', 0, 0, 0)]);
		assert.deepEqual(cut(structure, { ...roomy, minSize: 200 }).map(chunk => chunk.text),
			['First paragraph.\n\nFigure 1. An owl.\n\nSecond paragraph.']);
	});

	it('follows a paragraph continued past a footnote with the footnote, in the cut and in recovery', () => {
		let structure = pdf([pdfBlock('The results were', 0, 0, 10), aux('1 See Smith 2001.', 0, 0, 'paragraph'),
			pdfBlock('significant in every trial.', 1, 0, 10), pdfBlock('A later paragraph.', 1, 0, 0)]);
		link(structure, 0, 2);
		let [chunk] = cut(structure);
		assert.equal(chunk.text, 'The results were significant in every trial.\n\n1 See Smith 2001.\n\nA later paragraph.');
		assert.deepEqual(pages(chunk), [0, 1]);
		assert.equal(getAnchorContent(structure, chunk.anchor).text, chunk.text);
	});

	it('keeps what waited for a continued paragraph ahead of what follows it', () => {
		let structure = pdf([pdfBlock('The results were', 0, 0, 10), aux('Figure 1. Before.', 0, 5), aux('1 A footnote.', 0, 0, 'paragraph'),
			pdfBlock('significant in every trial.', 1, 0, 20), aux('Figure 2. After.', 1, 0, 10), pdfBlock('A later paragraph.', 1, 0, 0)]);
		link(structure, 0, 3);
		let [chunk] = cut(structure);
		assert.equal(chunk.text, 'The results were significant in every trial.\n\nFigure 1. Before.\n\n1 A footnote.\n\nFigure 2. After.\n\nA later paragraph.');
	});

	it('keeps a continued paragraph in the section it starts in, past an outline entry between its parts', () => {
		let structure = pdf([pdfBlock('The results were', 0, 0, 20), aux('1 A footnote.', 0, 10, 'paragraph'),
			aux('Table 2', 0, 0, 'heading'), aux('Sites and dates.', 1, 0, 20),
			pdfBlock('significant in every trial.', 1, 0, 10), pdfBlock('A later paragraph.', 1, 0, 0)]);
		link(structure, 0, 4);
		structure.catalog.outline = [{ title: 'Findings', ref: [0] }, { title: 'Table 2', ref: [2] }];
		let [chunk] = cut(structure, { ...roomy, minSize: 200 });
		assert.equal(chunk.text, 'The results were significant in every trial.\n\n1 A footnote.\n\nSites and dates.\n\nA later paragraph.');
		assert.equal(chunk.embedText,
			'Findings\n\nThe results were significant in every trial.\n\n1 A footnote.\n\nTable 2\n\nSites and dates.\n\nA later paragraph.');
		assert.deepEqual(cut(structure).map(chunk => [chunk.text, chunk.outlinePath]), [
			['The results were significant in every trial.\n\n1 A footnote.', 'Findings'],
			['Sites and dates.\n\nA later paragraph.', 'Table 2'],
		]);
	});

	it('names the section a continued paragraph starts in when a chunk opens with its later part', () => {
		let structure = pdf([pdfBlock('The results were', 0, 0, 20), aux('Table 2', 0, 0, 'heading'),
			pdfBlock('significant in every trial. The effect held at every site we visited.', 1, 0, 10)]);
		link(structure, 0, 2);
		structure.catalog.outline = [{ title: 'Findings', ref: [0] }, { title: 'Table 2', ref: [1] }];
		let chunks = cut(structure, { maxSize: 60, minSize: 0, overlap: 0 });
		let opening = chunks.find(chunk => chunk.text.startsWith('The effect'));
		assert.ok(opening);
		assert.equal(opening.outlinePath, 'Findings');
		assert.equal(getAnchorContent(structure, opening.anchor).outlinePath, 'Findings');
	});

	it('does not read a paragraph as continuing excluded text, in the cut or in recovery', () => {
		let structure = pdf([pdfBlock('Running header', 0, 0, 30, { flowClass: 'excluded' }), aux('Figure 1. Owls.', 0, 20),
			pdfBlock('A paragraph the header points at.', 0, 0, 10), pdfBlock('Another paragraph.', 0, 0, 0)]);
		link(structure, 0, 2);
		let [chunk] = cut(structure);
		assert.equal(chunk.text, 'Figure 1. Owls.\n\nA paragraph the header points at.\n\nAnother paragraph.');
	});

	it('keeps a caption opening an outline section with that section', () => {
		let structure = pdf([pdfBlock('Intro text.', 0, 0, 30), pdfBlock('More intro.', 0, 0, 20), aux('Table 1. Sites.', 0, 10, 'table'), pdfBlock('Results text.', 0, 0, 0)]);
		structure.catalog.outline = [{ title: 'Introduction', ref: [0] }, { title: 'Results', ref: [2] }];
		let [chunk] = cut(structure, {});
		assert.equal(chunk.text, 'Intro text.\n\nMore intro.\n\nTable 1. Sites.\n\nResults text.');
		assert.equal(chunk.embedText, 'Introduction\n\nIntro text.\n\nMore intro.\n\nResults\n\nTable 1. Sites.\n\nResults text.');
	});

	it('keeps a caption between a heading and its first paragraph with that paragraph, in document order', () => {
		let structure = pdf([pdfBlock('Methods', 0, 0, 30, { type: 'heading' }), aux('Figure 2. Setup.', 0, 20),
			pdfBlock('We tracked forty owls.', 0, 0, 10), pdfBlock('Another paragraph.', 0, 0, 0)]);
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }];
		let [chunk] = cut(structure);
		assert.equal(chunk.text, 'Figure 2. Setup.\n\nWe tracked forty owls.\n\nAnother paragraph.');
		assert.equal(chunk.embedText, 'Methods\n\nFigure 2. Setup.\n\nWe tracked forty owls.\n\nAnother paragraph.');
	});

	it('never leaves auxiliary text as a chunk of its own, however long the body before it', () => {
		let body = 'Body sentence about owls. '.repeat(20);
		let structure = pdf([pdfBlock(body, 0, 0, 10), aux('Figure 2. Owls at dusk.', 0, 0)]);
		let chunks = cut(structure, { ...roomy, minSize: 0 });
		assert.equal(chunks.length, 1);
		assert.ok(chunks[0].text.endsWith('\n\nFigure 2. Owls at dusk.'));
	});

	it('pdf/1: places real footnotes and captions where the rules say', () => {
		let data = fixtures.find(fixture => fixture.format === 'pdf' && fixture.name === '1')?.data;
		assert.ok(data, 'fixture pdf/1');
		let folded = getChunks(data).map(chunk => chunk.text).join('\n\n');
		// A paragraph continued past footnote 2, a figure and its caption still reads as one
		assert.ok(folded.includes('if loops are nested to a depth k, and each loop is entered with m different type maps'));
		// The footnote follows that paragraph rather than cutting into it
		assert.ok(folded.indexOf('2 Instead of aborting the outer recording') > folded.indexOf('the resulting trace trees will be tractable.'));
		// A caption sits between the listing and the paragraph after it
		let caption = 'Figure 1. Sample program: sieve of Eratosthenes.';
		assert.ok(folded.indexOf(caption) > folded.indexOf('primes[k] = false;'));
		assert.ok(folded.indexOf(caption) < folded.indexOf('Interpret Bytecodes'));
		// A footnote below a plain paragraph follows that paragraph
		assert.ok(folded.indexOf('1 Arrays are actually worse than this') > folded.indexOf('cover all the hot paths of the program.'));
	});

	for (let { format, name, data } of fixtures) {
		it(`${format}/${name}: recovers every chunk of the folded cut`, () => {
			let chunks = getChunks(data);
			assert.ok(chunks.length);
			assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(data));
			for (let chunk of chunks) assert.equal(recoveredText(data, restore(chunk.anchor)), chunk.text);
		});

		it(`${format}/${name}: cuts every chunk in reading order`, () => {
			let document = getDocument(data);
			for (let { spans } of iterateChunks(data, undefined)) {
				assert.deepEqual(readingOrder(document, spans), spans);
			}
		});
	}
});

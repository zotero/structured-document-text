import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent } from '../../src/chunker/index.js';
import { noOverlap, document, pdfBlock, dom, restore } from './helpers.js';

const heading = (text, page = 0) => pdfBlock(text, page, 0, 0, { type: 'heading' });
const location = ({ text, outlinePath, pageLabel }) => ({ text, outlinePath, pageLabel });

describe('recovering a chunk with its location', () => {
	it('names the section and page at the first recovered text, as the chunk does', () => {
		let structure = document([
			heading('Introduction', 0), pdfBlock('Owls hunt at night. '.repeat(20), 0, 0, 1),
			heading('Methods', 1), pdfBlock('We tracked forty owls. '.repeat(20), 1, 0, 1),
			pdfBlock('Their routes crossed the Baltic. '.repeat(20), 2, 0, 1),
		], 'pdf', {
			outline: [{ title: 'Introduction', ref: [0] }, { title: 'Methods', ref: [2] }],
			pages: [{ label: 'i', contentRange: [[0], [2]] }, { contentRange: [[2], [4]] }, { label: '3', contentRange: [[4], [5]] }],
		});
		let chunks = getChunks(structure, noOverlap);
		assert.ok(chunks.length > 3);
		assert.deepEqual(new Set(chunks.map(chunk => chunk.outlinePath)), new Set(['Introduction', 'Methods']));
		assert.deepEqual(new Set(chunks.map(chunk => chunk.pageLabel)), new Set(['i', '2', '3']));
		for (let chunk of chunks) {
			assert.deepEqual(getAnchorContent(structure, restore(chunk.anchor)), location(chunk));
		}
	});

	it('locates DOM chunks by their outline, without a page for location mappings', () => {
		for (let type of ['epub', 'snapshot']) {
			let structure = dom(['First section text.', 'Second section text.', 'More of the second.'], type);
			structure.catalog.outline = [{ title: 'One', ref: [0] }, { title: 'Two', ref: [1] }];
			let chunks = getChunks(structure, noOverlap);
			for (let chunk of chunks) {
				assert.deepEqual(getAnchorContent(structure, restore(chunk.anchor)), location(chunk));
			}
			assert.equal(chunks.at(-1).outlinePath, 'Two');
			assert.equal(getAnchorContent(structure, chunks.at(-1).anchor).pageLabel, null);
		}
	});

	it('returns null for nothing to recover', () => {
		let structure = dom(['Body'], 'snapshot');
		assert.equal(getAnchorContent(structure, null), null);
		assert.equal(getAnchorContent(structure, { selectors: [] }), null);
		assert.equal(getAnchorContent(structure, { selectors: [{ type: 'TextPositionSelector', start: 40, end: 50 }] }), null);
		assert.equal(getAnchorContent(structure, { selectors: [null] }), null);
	});
});

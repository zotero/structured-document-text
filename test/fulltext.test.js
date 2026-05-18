import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFulltextFromStructuredText } from '../src/fulltext.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from './helpers.js';

const fixtures = discoverFixtures();

describe('getFulltextFromStructuredText', () => {
	it('respects nested content ranges and terminal text offsets', () => {
		const structure = {
			catalog: {
				pages: [{
					contentRanges: [
						[[0, 0, 2], [0, 0, 4]],
						[[1, 0, 0, 1], [1, 1, 0, 2]],
					],
				}],
			},
			content: [
				{
					type: 'paragraph',
					content: [{ text: 'abcdef' }],
				},
				{
					type: 'list',
					content: [
						{ type: 'listitem', content: [{ text: 'hello' }] },
						{ type: 'listitem', content: [{ text: 'world' }] },
					],
				},
				{
					type: 'paragraph',
					content: [{ text: 'outside' }],
				},
			],
		};

		assert.equal(getFulltextFromStructuredText(structure, [0]), 'cde\n\nello\nwor');
	});

	it('deduplicates overlapping terminal text spans without widening to whole blocks', () => {
		const structure = {
			catalog: {
				pages: [{
					contentRanges: [
						[[0, 0, 0], [0, 0, 3]],
						[[0, 0, 2], [0, 0, 5]],
					],
				}],
			},
			content: [{
				type: 'paragraph',
				content: [{ text: 'abcdef' }],
			}],
		};

		assert.equal(getFulltextFromStructuredText(structure, [0]), 'abcdef');
	});

	for (const { format, name, path, data } of fixtures) {
		describe(`${format}/${name}`, () => {
			it('produces expected fulltext', () => {
				const pageIndexes = data.catalog.pages.map((_, i) => i);
				const result = getFulltextFromStructuredText(data, pageIndexes);

				if (isUpdateMode()) {
					writeExpected(path, name, 'fulltext.txt', result);
					return;
				}

				const expected = readExpected(path, name, 'fulltext.txt');
				assert.notEqual(expected, undefined, `Missing expected file: ${name}.fulltext.txt (run npm run test:update)`);
				assert.equal(result, expected);
			});
		});
	}
});

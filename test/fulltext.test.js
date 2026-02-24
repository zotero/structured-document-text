import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFulltextFromStructuredText } from '../src/fulltext.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from './helpers.js';

const fixtures = discoverFixtures();

describe('getFulltextFromStructuredText', () => {
	for (const { format, name, path, data } of fixtures) {
		describe(`${format}/${name}`, () => {
			it('produces expected fulltext', () => {
				const pageIndexes = data.pages.map((_, i) => i);
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { estimateTokens } from '../../src/chunker/chunks.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from '../helpers.js';
import { restore, recoveredText } from './helpers.js';

const fixtures = discoverFixtures();

describe('real document fixtures', () => {
	for (let { format, name, data, path } of fixtures) {
		it(`${format}/${name}: every chunk has a source anchor`, () => {
			let chunks = getChunks(data);
			assert.ok(chunks.length, 'Fixture must produce chunks');
			assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(data));
			for (let chunk of chunks) {
				assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7, 'Complete embedding input exceeds estimated token budget');
				let { anchor } = chunk;
				assert.ok(anchor);
				let text = recoveredText(data, restore(anchor));
				assert.equal(text, chunk.text);
			}
			assert.ok(getTextChunks(data, { maxSize: 2400 }).every(chunk => chunk.embedText.length <= 2400));
		});
		it(`${format}/${name}: preserves expected chunks, including source anchors`, () => {
			// The snapshot shows where captions and footnotes land; keep
			// geometry on one line per field.
			let chunks = getChunks(data).map(chunk => {
				let fields = Object.entries(chunk).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
				return `  {\n${fields.join(',\n')}\n  }`;
			});
			let actual = `[\n${chunks.join(',\n')}\n]\n`;
			if (isUpdateMode()) writeExpected(path, name, 'chunks.json', actual);
			let expected = readExpected(path, name, 'chunks.json');
			assert.notEqual(expected, undefined, `Missing ${format}/${name}.chunks.json (run npm run test:update)`);
			assert.equal(actual, expected);
		});
	}
});

for (const { format, name, data } of fixtures) {
	if (format === 'snapshot' && name === '2') {
		it('snapshot/2: recovers containers extending beyond the extracted article', () => {
			for (let value of [
				'body > div:nth-child(4)', 'body > div:nth-child(4) > div',
				'body > div:nth-child(4) > div > div:nth-child(3)',
				'#content', '#bodyContent', '#mw-content-text',
				'#mw-content-text > div:first-child', '#mwAQ', '#mwCXs',
			]) {
				let text = recoveredText(data, { selectors: [{ type: 'CssSelector', value }] });
				let prefix = value === '#mwCXs' ? 'EPIC Pacific Ocean' : 'Pacific Ocean';
				assert.ok(text?.startsWith(prefix), `${value}: missing selected article text`);
			}
		});
	}

	it(`${format}/${name}: recovers small chunks at interior source boundaries`, () => {
		let chunks = getChunks(data, { maxSize: 60, minSize: 0, overlap: 7 });
		assert.ok(chunks.length, 'Fixture must produce chunks');
		for (let [i, chunk] of chunks.entries()) {
			let where = `${format}/${name} chunk ${i}: ${JSON.stringify(chunk.text)}`;
			assert.ok(chunk.embedText.length <= 60, `${where}: embedding input exceeds character budget`);
			let recovered = recoveredText(data, restore(chunk.anchor));
			assert.equal(typeof recovered, 'string', `${where}: anchor does not resolve`);
			// Whole-element anchors and overlapping glyphs can recover more text;
			// their exact behavior is covered by focused DOM/PDF recovery tests.
			assert.ok(recovered.includes(chunk.text), `${where}: recovered text is truncated or different`);
		}
	});
}

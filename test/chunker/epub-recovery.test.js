import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getChunks } from '../../src/chunker/index.js';
import { recoveredText } from './helpers.js';

const blockPath = '/6/2!/4/2';
const position = (start, end, path = `${blockPath}/1`) => ({
	type: 'FragmentSelector', value: `epubcfi(${path},:${start},:${end})`,
});
const document = (text, anchor = { selectorMap: '/1' }) => ({
	metadata: { processor: { type: 'epub' } },
	catalog: { outline: [], pages: [] },
	content: [{ type: 'paragraph', anchor: { selectorMap: blockPath }, content: [{ text, anchor }] }],
});

it('recovers saved positions when the resolved EPUB text becomes shorter', () => {
	let [chunk] = getChunks(document('Read ↩︎'));
	assert.equal(recoveredText(document('Read ↩'), JSON.parse(JSON.stringify(chunk.anchor))), 'Read ↩');
});

it('clamps to the matched selector-map part without consuming the next DOM text node', () => {
	let structure = document('↩tail', { selectorMap: '1 /1\n4 /3' });
	assert.equal(recoveredText(structure, { selectors: [position(0, 2)] }), '↩');
	assert.equal(recoveredText(structure, { selectors: [position(1, 2)] }), null);
});

it('uses deltaMap translation before clamping within a merged text node', () => {
	let structure = document('é↩tail', { selectorMap: '2 /1\n4 /3', deltaMap: '1 -1 2 -2' });
	assert.equal(recoveredText(structure, { selectors: [position(2, 4)] }), '↩');
	assert.equal(recoveredText(structure, { selectors: [position(2, 5)] }), '↩');
	assert.equal(recoveredText(structure, { selectors: [position(4, 5)] }), null);
	assert.equal(recoveredText(structure, { selectors: [position(0, 4, `${blockPath}/3`)] }), 'tail');
});

it('rejects invalid, empty, reversed and wholly out-of-text offset ranges', () => {
	let structure = document('↩');
	for (let [start, end] of [[-1, 1], [0, 1.5], [0, 'NaN'], [0, '9007199254740992'],
		[0, 0], [1, 0], [1, 2], [2, 3]]) {
		assert.equal(recoveredText(structure, { selectors: [position(start, end)] }), null, `${start}..${end}`);
	}
});

it('does not use offset tolerance to guess missing or ambiguous text paths', () => {
	let structure = document('Body');
	assert.equal(recoveredText(structure, { selectors: [position(0, 5, '/6/999!/4/2/1')] }), null);
	assert.equal(recoveredText(structure, { selectors: [position(0, 5, `${blockPath}/99`)] }), null);
	let duplicate = document('AB', { selectorMap: '1 /1\n1 /1' });
	assert.equal(recoveredText(duplicate, { selectors: [position(0, 2)] }), null);
});

it('preserves character and element endpoints when their source paths coincide', () => {
	for (let selectorMap of ['', '/1']) {
		let anchored = { text: 'Body', anchor: { selectorMap } };
		let synthetic = { text: 'Image description' };
		for (let [content, value] of [
			[[anchored, synthetic], `epubcfi(${blockPath},${selectorMap}:0,)`],
			[[synthetic, anchored], `epubcfi(${blockPath},,${selectorMap}:4)`],
			[[{ ...anchored, text: 'x' }], `epubcfi(${blockPath}${selectorMap},:0,:1)`],
		]) {
			let structure = document('');
			structure.content[0].content = content;
			let [chunk] = getChunks(structure);
			assert.equal(chunk.anchor.selectors[0].value, value);
			assert.equal(recoveredText(structure, JSON.parse(JSON.stringify(chunk.anchor))), chunk.text);
		}
	}
	let structure = document('Image description', {});
	let [chunk] = getChunks(structure);
	assert.equal(chunk.anchor.selectors[0].value, `epubcfi(${blockPath})`);
	assert.equal(recoveredText(structure, JSON.parse(JSON.stringify(chunk.anchor))), chunk.text);
});

it('recovers all saved passages in the paired EPUB extraction fixtures', () => {
	let read = name => JSON.parse(readFileSync(new URL(`../fixtures/epub/${name}.json`, import.meta.url), 'utf8'));
	let original = read('1'), advanced = read('1_advanced');
	for (let options of [undefined, { maxSize: 60, minSize: 0, overlap: 7 },
		{ maxSize: 200, minSize: 0, overlap: 7 }]) {
		let chunks = getChunks(original, options);
		assert.ok(chunks.length, 'Fixture must produce chunks');
		for (let [i, chunk] of chunks.entries()) {
			let recovered = recoveredText(advanced, JSON.parse(JSON.stringify(chunk.anchor)));
			assert.ok(typeof recovered === 'string' && recovered.trim(), `Unresolved chunk ${i}, size ${options?.maxSize ?? 'default'}`);
		}
	}
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { splitText } from '../../src/chunker/split.js';
import { dom, recoveredText } from './helpers.js';

it('starts default passage overlap at complete sentences', () => {
	let text = Array.from({ length: 230 }, (_, i) =>
		`Sentence ${String.fromCharCode(65 + i % 26)} has some meaning of its own.`).join(' ');
	let structure = { metadata: { processor: { type: 'snapshot' } }, catalog: { outline: [], pages: [] },
		content: [{ type: 'paragraph', anchor: { selectorMap: '#p' },
			content: [{ text, anchor: { stream: 0 } }] }] };
	let chunks = getChunks(structure);
	assert.ok(chunks.length > 1);
	for (let [i, chunk] of chunks.entries()) {
		assert.ok(chunk.text.startsWith('Sentence '), chunk.text.slice(0, 80));
		assert.ok(chunk.tokens <= 768);
		assert.equal(recoveredText(structure, chunk.anchor), chunk.text);
		if (i) {
			let previous = chunks[i - 1].anchor.selectors[0];
			let current = chunk.anchor.selectors[0];
			assert.ok(current.start > previous.start && current.start < previous.end);
		}
	}
});

for (let separator of [' ', '   ']) {
	it(`keeps whole-sentence overlap within the budget with ${separator.length} separating spaces`, () => {
		let sentence = 'A complete sentence.';
		let text = Array(20).fill(sentence).join(separator);
		for (let overlap of [sentence.length, sentence.length + 7]) {
			let pieces = [...splitText(text, 80, 0, overlap)];
			for (let [i, piece] of pieces.entries()) {
				assert.ok(text.slice(piece.start, piece.end).startsWith(sentence));
				assert.ok(piece.end - piece.start <= 80);
				if (!i) continue;
				assert.ok(piece.start > pieces[i - 1].start);
				assert.ok(piece.end > pieces[i - 1].end);
				assert.ok(pieces[i - 1].end - piece.start <= overlap);
				assert.ok(piece.start < pieces[i - 1].end);
			}
			assert.equal(pieces.at(-1).end, text.length);
		}
	});
}

it('keeps word-aligned overlap when a sentence exceeds the overlap budget', () => {
	let text = 'longword '.repeat(40).trim() + '.';
	let pieces = [...splitText(text, 80, 0, 20)];
	for (let [i, piece] of pieces.entries()) {
		assert.ok(text.slice(piece.start, piece.end).startsWith('longword'));
		if (!i) continue;
		assert.ok(piece.start < pieces[i - 1].end);
		assert.ok(pieces[i - 1].end - piece.start <= 20);
		assert.ok(piece.end > pieces[i - 1].end);
	}
	assert.equal(pieces.at(-1).end, text.length);
});

it('balances the final word-aligned pair including its overlap', () => {
	let text = 'word '.repeat(180).trim();
	let pieces = [...splitText(text, 700, 0, 400)];
	assert.equal(pieces.length, 2);
	assert.equal(pieces[0].start, 0);
	assert.equal(pieces[1].end, text.length);
	assert.ok(pieces.every(piece => piece.end - piece.start <= 700));
	let carried = pieces[0].end - pieces[1].start;
	assert.ok(carried >= 395 && carried <= 400);
	assert.ok(Math.abs(pieces[0].end - (pieces[1].end - pieces[1].start)) <= 5);
});

it('avoids near-duplicate tails with large sentence overlap in token mode', () => {
	let sentences = Array.from({ length: 200 }, (_, i) => `这是第${i}个句子。`);
	let structure = dom([sentences.join('')], 'snapshot');
	let chunks = getChunks(structure, { maxTokens: 512, overlap: 400 });
	assert.ok(chunks.length <= 8, `Expected a few overlapping chunks, got ${chunks.length}`);
	for (let sentence of sentences) assert.ok(chunks.some(chunk => chunk.text.includes(sentence)));
	for (let chunk of chunks) {
		assert.ok(chunk.tokens <= 512);
		assert.equal(recoveredText(structure, chunk.anchor), chunk.text);
	}
});

it('balances paragraph splits without reserving overlap they do not carry', () => {
	let paragraphs = ['a'.repeat(30), 'b'.repeat(18), 'c'.repeat(18)];
	let text = paragraphs.join('\n\n');
	let pieces = [...splitText(text, 60, 0, 30)];
	assert.deepEqual(pieces.map(({ start, end }) => text.slice(start, end)), [
		paragraphs[0], paragraphs.slice(1).join('\n\n'),
	]);
});

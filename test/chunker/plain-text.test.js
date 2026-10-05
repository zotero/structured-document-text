import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPlainTextChunks, getTextChunks } from '../../src/chunker/text.js';
import { noOverlap, paragraph, textDocument } from './helpers.js';

describe('plain text chunking', () => {
	it('splits paragraphs at blank lines and joins wrapped lines with a space', () => {
		let chunks = getPlainTextChunks('  First line.  \n\n   \nSecond line.\nThird line.  ');
		let expected = getTextChunks(textDocument(['First line.', 'Second line. Third line.'].map(line => paragraph(line))));
		assert.deepEqual(chunks, expected);
		assert.equal(chunks[0].text, 'First line.\n\nSecond line. Third line.');
	});

	it('reads a page break as a space, even between blank lines', () => {
		let joined = getPlainTextChunks('Ends on one page and continues.');
		assert.deepEqual(getPlainTextChunks('Ends on one page\n\n\n\fand continues.'), joined);
		assert.deepEqual(getPlainTextChunks('Ends on one page\fand continues.'), joined);
		assert.equal(joined[0].text, 'Ends on one page and continues.');
	});

	it('cuts the same text the same way whatever its line endings', () => {
		let lines = Array.from({ length: 40 }, (_, i) => `Line ${i} says something about owls and their habits.`);
		let chunks = getPlainTextChunks(lines.join('\n'), noOverlap);
		assert.ok(chunks.length > 1);
		assert.deepEqual(getPlainTextChunks(lines.join('\r\n'), noOverlap), chunks);
		assert.deepEqual(getPlainTextChunks(lines.join('\r'), noOverlap), chunks);
		// Wrapped lines are one paragraph, cut at sentences
		assert.deepEqual(getPlainTextChunks(lines.join(' '), noOverlap), chunks);
		assert.ok(chunks.every(chunk => !chunk.text.includes('\n')));
	});

	it('relies on text selection keeping every node of a format without an anchor rule', () => {
		let structure = { metadata: { processor: { type: 'text' } }, catalog: {}, content: [paragraph('Unanchored body')] };
		assert.deepEqual(getTextChunks(structure).map(chunk => chunk.text), ['Unanchored body']);
		// The same unanchored node is dropped under a format that has a rule
		structure.metadata.processor.type = 'pdf';
		assert.deepEqual(getTextChunks(structure), []);
	});

	it('returns nothing for text without content and validates its input', () => {
		assert.deepEqual(getPlainTextChunks(''), []);
		assert.deepEqual(getPlainTextChunks(' \n\t\n\f'), []);
		assert.throws(() => getPlainTextChunks(null), TypeError);
		assert.throws(() => getPlainTextChunks('Body', { maxTokens: 1 }), TypeError);
	});
});

import { countChunks, iterateChunks } from './chunks.js';

export const CHUNKER_VERSION = 1;

/**
 * Split an immutable, materialized SDT. No source geometry is decoded.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./text').TextChunk[]}
 */
export function getTextChunks(structure, options) {
	return Array.from(iterateChunks(structure, options, false));
}

/**
 * Count the same selected chunks without constructing outputs or decoding geometry.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {number}
 */
export function getChunkCount(structure, options) {
	return countChunks(structure, options);
}

/**
 * Split plain text with no structure. Blank lines separate paragraphs; a
 * single newline is a wrapped line and a form feed a page break, neither
 * of which ends a paragraph, so both read as a space.
 * @param {string} text
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./text').TextChunk[]}
 */
export function getPlainTextChunks(text, options) {
	if (typeof text !== 'string') throw new TypeError('text must be a string');
	// A paragraph is the text between two blank lines, its wrapped lines
	// joined with spaces. A page break goes first, taking the blank lines
	// around it, so a paragraph continues across pages. The paragraphs are
	// in a format with no source anchors: text selection keeps every node
	// of a format it has no anchor rule for.
	let content = [];
	for (let paragraph of text.replace(/\r\n?/gu, '\n').replace(/\s*\f\s*/gu, ' ').split(/\n[ \t]*\n/u)) {
		let joined = paragraph.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
		if (joined) content.push({ type: 'paragraph', content: [{ text: joined }] });
	}
	return getTextChunks({ metadata: { processor: { type: 'text' } }, catalog: {}, content }, options);
}

import { getNestedBlockPlainText } from './text.js';

/**
 * Convert a structure object into a fulltext string for the given page indexes.
 *
 * @param {Object} structure - The structured data from getFullStructure/getStructure
 * @param {number[]} pageIndexes - Array of page indexes to include
 * @returns {string} The fulltext string, NFC normalized
 */
export function getFulltextFromStructuredText(structure, pageIndexes) {
	const emittedBlocks = new Set();
	const blockTexts = [];

	for (const pageIndex of pageIndexes) {
		const page = structure.pages[pageIndex];
		if (!page || !Array.isArray(page.contentRanges)) continue;

		for (const range of page.contentRanges) {
			if (!range.start?.ref || !range.end?.ref) continue;

			const startIdx = range.start.ref[0];
			const endIdx = range.end.ref[0];

			for (let i = startIdx; i <= endIdx; i++) {
				if (emittedBlocks.has(i)) continue;
				emittedBlocks.add(i);

				const block = structure.content[i];
				if (!block || block.artifact) continue;

				const text = getNestedBlockPlainText(block);
				if (text) {
					blockTexts.push(text);
				}
			}
		}
	}

	return blockTexts.join('\n\n').trim().normalize('NFC');
}

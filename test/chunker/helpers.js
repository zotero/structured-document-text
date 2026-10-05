import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorPositions } from '../../src/chunker/index.js';

export const noOverlap = { maxSize: 100, minSize: 0, overlap: 0 };
export const paragraph = (text, extra = {}) => ({ type: 'paragraph', content: [{ text }], ...extra });
export const document = (content, type = 'pdf', catalog = {}) => ({
	metadata: { processor: { type, version: 1 } }, catalog: { outline: [], pages: [], ...catalog }, content,
});
export const restore = value => JSON.parse(JSON.stringify(value));
export const pdfAnchor = positions => ({ pageRects: positions.flatMap(({ pageIndex, rects }) => rects.map(rect => [pageIndex, ...rect])) });
// The recovered text alone, for tests of what an anchor covers.
export const recoveredText = (structure, anchor) => getAnchorContent(structure, anchor)?.text ?? null;

// Text-focused tests still use anchored SDT, without manufacturing PDF geometry.
export function textDocument(content, catalog = {}) {
	let stream = 0;
	function anchor(block, path) {
		return { ...block, anchor: { selectorMap: `#block-${path}` }, content: block.content.map((node, i) => {
			if (typeof node.text !== 'string') return anchor(node, `${path}-${i}`);
			let anchored = { ...node, anchor: { stream } };
			stream += node.text.length;
			return anchored;
		}) };
	}
	return document(content.map((block, i) => anchor(block, i)), 'snapshot', catalog);
}

export function pdfBlock(text, page = 0, x = 0, y = 0, extra = {}) {
	let runs = [];
	let startX = x;
	for (let char of text) {
		if (![' ', '\n', '\t'].includes(char)) runs.push([0, page, x, y, x + 1, y + 1]);
		x += 1;
	}
	return paragraph(text, { ...extra, anchor: { pageRects: [[page, startX, y, x, y + 1]] },
		content: [{ text, anchor: { textMap: JSON.stringify(runs) } }] });
}

export function pdf(content) {
	let max = Math.max(...content.flatMap(block => block.anchor?.pageRects?.map(rect => rect[0]) ?? [0]));
	return document(content, 'pdf', { pages: Array.from({ length: max + 1 }, () => ({ contentRange: [[0], [content.length]] })) });
}

export function dom(texts, type, excluded = []) {
	let stream = 0;
	return document(texts.map((text, i) => {
		let block = paragraph(text, {
			anchor: { selectorMap: type === 'epub' ? `/6/2!/4/${2 * (i + 1)}` : `#p${i}` },
			content: [{ text, anchor: type === 'epub' ? { selectorMap: '/1' } : { stream } }],
			...(excluded.includes(i) ? { flowClass: 'excluded' } : {}),
		});
		stream += text.length;
		return block;
	}), type);
}

export function roundTrip(structure, options) {
	return getChunks(structure, options).map(chunk => {
		let { anchor } = chunk;
		let positions = getAnchorPositions(structure, restore(anchor));
		assert.ok(positions?.length, `No positions for ${JSON.stringify(chunk.text)}`);
		assert.deepEqual(getAnchorContent(structure, restore(anchor)),
			{ text: chunk.text, outlinePath: chunk.outlinePath, pageLabel: chunk.pageLabel });
		return { chunk, anchor, positions };
	});
}

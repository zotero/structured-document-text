import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTextAttributes } from '../src/pdf/block-transform.js';
import { parseTextMap, buildRunData } from '../src/pdf/decode.js';

// Build a textMap with one position per non-whitespace character.
// All chars share the same line bbox; widths are simple per-char widths or
// [delta, width] pairs to encode the gap left by whitespace.
function makeTextMap(chars) {
	const widths = [];
	let pos = 0;
	let prevEnd = 0;
	for (const c of chars) {
		const delta = c.x1 - prevEnd;
		const w = c.x2 - c.x1;
		if (Math.abs(delta) > 0.01) {
			widths.push([delta, w]);
		}
		else {
			widths.push(w);
		}
		prevEnd = c.x2;
		pos = c.x2;
	}
	const minX = chars[0].x1;
	const maxX = chars.at(-1).x2;
	return JSON.stringify([[0, 0, minX, 0, maxX, 10, ...widths]]);
}

describe('applyTextAttributes textMap slicing', () => {
	it('slices textMap by text-character offsets (incl. whitespace), not run positions', () => {
		// text "abc def gh" with chars at known x positions and a single text node
		const text = 'abc def gh';
		const charPositions = [
			{ x1: 0, x2: 5 },   // a
			{ x1: 5, x2: 10 },  // b
			{ x1: 10, x2: 15 }, // c
			{ x1: 20, x2: 25 }, // d (delta 5 for space)
			{ x1: 25, x2: 30 }, // e
			{ x1: 30, x2: 35 }, // f
			{ x1: 40, x2: 45 }, // g (delta 5 for space)
			{ x1: 45, x2: 50 }, // h
		];

		const textMap = makeTextMap(charPositions);

		// Single block with a single text node, then split out "d" via attributes.
		const structure = {
			content: [{
				type: 'paragraph',
				content: [{
					text,
					anchor: { textMap, pageRects: [[0, 0, 0, 50, 10]] },
				}],
				anchor: { pageRects: [[0, 0, 0, 50, 10]] },
			}],
		};

		// "d" is at text offset 4 (after "abc ")
		applyTextAttributes(structure, [0], 4, 4, node => ({ ...node, refs: [[1]] }));

		const nodes = structure.content[0].content;
		assert.equal(nodes.length, 3, 'split into before/range/after');
		assert.equal(nodes[0].text, 'abc ');
		assert.equal(nodes[1].text, 'd');
		assert.equal(nodes[2].text, 'ef gh');

		// Each text node's textMap should contain rects only for its non-ws chars
		const before = buildRunData(parseTextMap(nodes[0].anchor.textMap));
		const range = buildRunData(parseTextMap(nodes[1].anchor.textMap));
		const after = buildRunData(parseTextMap(nodes[2].anchor.textMap));

		assert.equal(before.length, 3, 'before has 3 char rects (a, b, c)');
		assert.equal(range.length, 1, 'range has 1 char rect (d)');
		assert.equal(after.length, 4, 'after has 4 char rects (e, f, g, h)');

		// Verify rects are at the positions of the actual characters, not shifted.
		assert.deepEqual(before.map(r => [r.rect[0], r.rect[2]]),
			[[0, 5], [5, 10], [10, 15]],
			'before maps to a, b, c rects');
		assert.deepEqual(range.map(r => [r.rect[0], r.rect[2]]),
			[[20, 25]],
			'range maps to d rect');
		assert.deepEqual(after.map(r => [r.rect[0], r.rect[2]]),
			[[25, 30], [30, 35], [40, 45], [45, 50]],
			'after maps to e, f, g, h rects');
	});
});

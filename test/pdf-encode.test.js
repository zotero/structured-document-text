import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { charsToPreformattedTextNodes } from '../src/pdf/encode.js';
import { buildRunData, parseTextMap } from '../src/pdf/decode.js';
import { optimizeTextMapRun } from '../src/pdf/text-map.js';

const char = (c, x, y = 0, extra = {}) => ({ c, rect: [x, y, x + 5, y + 10], axisDir: 0, monospace: true, ...extra });
const geometry = node => buildRunData(parseTextMap(node.anchor?.textMap));
const text = nodes => nodes.map(node => node.text).join('');

describe('preformatted PDF text geometry', () => {
	it('compacts long lines without changing glyph geometry or direction', () => {
		for (let axisDir of [0, 1, 2, 3]) {
			let vertical = !!(axisDir % 2);
			let chars = Array.from({ length: 200 }, (_, i) => ({
				c: 'x', axisDir, rtl: true, monospace: true,
				rect: vertical ? [0, i * 6, 10, i * 6 + 5] : [i * 6, 0, i * 6 + 5, 10],
			}));
			let nodes = charsToPreformattedTextNodes(2, chars);
			assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 2, rect: ch.rect, vertical })));
			let maps = nodes.map(node => node.anchor.textMap).join('');
			let separateRuns = JSON.stringify(chars.map(ch => [(axisDir << 1) | 8, 2, ...ch.rect]));
			assert.ok(maps.length < separateRuns.length / 2, 'Repeated glyph metadata should be compacted');
		}
	});

	it('keeps overlaps, backwards runs and changing baselines at their original coordinates', () => {
		let chars = [char('a', 10), char('b', 13), char('c', 3), char('d', 8, 1),
			char('e', 13, 1, { rtl: true }), char('f', 18, 1, { rtl: true })];
		let nodes = charsToPreformattedTextNodes(1, chars);
		assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 1, rect: ch.rect, vertical: false })));
	});

	it('compacts fractional coordinates without arithmetic noise or geometry drift', () => {
		for (let axisDir of [0, 1, 2, 3]) {
			let vertical = !!(axisDir % 2);
			let chars = Array.from({ length: 2000 }, (_, i) => {
				let start = 40.3 + i * 5.1;
				return { c: 'x', axisDir, monospace: true,
					rect: vertical ? [20.3, start, 30.3, start + 4.7] : [start, 20.3, start + 4.7, 30.3] };
			});
			let separateRuns = chars.map(ch => optimizeTextMapRun([axisDir << 1, 2, ...ch.rect]));
			let expected = buildRunData(separateRuns);
			let nodes = charsToPreformattedTextNodes(2, chars);
			let actual = nodes.flatMap(geometry);
			assert.equal(actual.length, expected.length);
			for (let [i, glyph] of actual.entries()) {
				assert.equal(glyph.pageIndex, expected[i].pageIndex);
				assert.equal(glyph.vertical, expected[i].vertical);
				for (let j = 0; j < 4; j++) {
					assert.ok(Math.abs(glyph.rect[j] - expected[i].rect[j]) < 1e-6, 'Preserve quantized glyph boundaries');
				}
			}
			let maps = nodes.map(node => node.anchor.textMap).join('');
			assert.doesNotMatch(maps, /\.\d{7}/u, 'Do not serialize floating-point subtraction noise');
			assert.ok(maps.length < JSON.stringify(separateRuns).length / 2, 'Keep fractional maps compact');
		}
	});

	it('preserves source rectangles through indentation, column gaps and style changes', () => {
		const chars = [char('a', 0, 0, { lineBreakAfter: true }),
			char('b', 10, 20, { bold: true }), char('c', 20, 20, { bold: true })];
		const nodes = charsToPreformattedTextNodes(3, chars);
		assert.equal(text(nodes), 'a\n  b c');
		assert.deepEqual(nodes.map(({ anchor, ...node }) => node), [
			{ text: 'a\n  ' }, { text: 'b c', style: { bold: true } },
		]);
		assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 3, rect: ch.rect, vertical: false })));
		assert.deepEqual(nodes.map(node => geometry(node).length), [1, 2]);
	});

	it('does not assign positions to whitespace or discarded line-end soft hyphens', () => {
		const chars = [char('a', 0), char('-', 5, 0, { softHyphen: true, lineBreakAfter: true }),
			char('b', 0, 20), char(' ', 5, 20), char('c', 10, 20)];
		const nodes = charsToPreformattedTextNodes(0, chars);
		assert.equal(text(nodes), 'a\nb c');
		assert.deepEqual(nodes.flatMap(geometry).map(run => run.rect), [chars[0].rect, chars[2].rect, chars[4].rect]);
		const whitespace = charsToPreformattedTextNodes(0, [char(' \t', 0)]);
		assert.equal(text(whitespace), ' \t');
		assert.ok(whitespace.every(node => !node.anchor));
	});

	it('keeps UTF-16 cluster positions aligned without counting embedded spaces', () => {
		const nodes = charsToPreformattedTextNodes(2, [char('😀', 0), char('a b', 5)]);
		assert.equal(text(nodes), '😀a b');
		assert.deepEqual(nodes.flatMap(geometry).map(run => run.rect), [
			[0, 0, 5, 10], [5, 0, 5, 10], [5, 0, 10, 10], [10, 0, 10, 10],
		]);
	});

	it('preserves source order and direction for RTL and vertical glyphs', () => {
		for (const axisDir of [0, 1, 2, 3]) {
			const chars = [char('א', 10, 0, { rtl: true, axisDir }), char('ב', 0, 20, { rtl: true, axisDir })];
			const nodes = charsToPreformattedTextNodes(1, chars);
			assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 1, rect: ch.rect, vertical: !!(axisDir % 2) })));
			assert.ok(nodes.flatMap(node => parseTextMap(node.anchor.textMap)).every(run => run[0] === (axisDir << 1) + 8));
		}
	});

	it('omits an incomplete node map instead of shifting later glyph positions', () => {
		const nodes = charsToPreformattedTextNodes(0, [char('a', 0), char('b', 5, 0, { rect: null }),
			char('c', 10), char('d', 15, 0, { bold: true })]);
		assert.equal(text(nodes), 'ab cd');
		assert.equal(nodes[0].anchor, undefined);
		assert.deepEqual(geometry(nodes[1]), [{ pageIndex: 0, rect: [15, 0, 20, 10], vertical: false }]);
	});
});

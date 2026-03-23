import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expandSelectorMap, parseSelectorMap, resolveSelectorMap } from '../../../src/dom/snapshot/decode.js';

describe('Snapshot decode: parseSelectorMap', () => {
	it('parses selector with no offset', () => {
		assert.deepStrictEqual(parseSelectorMap('h1'), { selector: 'h1', offset: 0 });
	});

	it('parses selector with offset 0', () => {
		assert.deepStrictEqual(parseSelectorMap('p:first-of-type 0'), { selector: 'p:first-of-type', offset: 0 });
	});

	it('parses selector with non-zero offset', () => {
		assert.deepStrictEqual(parseSelectorMap('p:first-of-type 25'), { selector: 'p:first-of-type', offset: 25 });
	});

	it('parses selector with large offset', () => {
		assert.deepStrictEqual(parseSelectorMap('div > p:nth-child(3) 1042'), { selector: 'div > p:nth-child(3)', offset: 1042 });
	});

	it('does not mistake pseudo-class numbers as offset', () => {
		assert.deepStrictEqual(parseSelectorMap('p:nth-child(3)'), { selector: 'p:nth-child(3)', offset: 0 });
	});

	it('handles selector with child combinator and spaces', () => {
		assert.deepStrictEqual(parseSelectorMap('ul > li:first-child'), { selector: 'ul > li:first-child', offset: 0 });
	});

	it('handles ID selector', () => {
		assert.deepStrictEqual(parseSelectorMap('#content'), { selector: '#content', offset: 0 });
	});

	it('handles ID selector with offset', () => {
		assert.deepStrictEqual(parseSelectorMap('#content 15'), { selector: '#content', offset: 15 });
	});

	it('handles complex nested selector with offset', () => {
		assert.deepStrictEqual(parseSelectorMap('#main > div:first-child > p:nth-child(2) 42'), {
			selector: '#main > div:first-child > p:nth-child(2)',
			offset: 42,
		});
	});
});

describe('Snapshot decode: resolveSelectorMap', () => {
	it('resolves sole-child text node (no offset)', () => {
		let result = resolveSelectorMap('h1', 0, 10);
		assert.deepStrictEqual(result, {
			type: 'CssSelector', value: 'h1',
			refinedBy: { type: 'TextPositionSelector', start: 0, end: 10 },
		});
	});

	it('resolves with base offset 0', () => {
		let result = resolveSelectorMap('p:first-of-type 0', 0, 21);
		assert.deepStrictEqual(result, {
			type: 'CssSelector', value: 'p:first-of-type',
			refinedBy: { type: 'TextPositionSelector', start: 0, end: 21 },
		});
	});

	it('resolves with non-zero base offset', () => {
		let result = resolveSelectorMap('p:first-of-type 25', 0, 5);
		assert.deepStrictEqual(result, {
			type: 'CssSelector', value: 'p:first-of-type',
			refinedBy: { type: 'TextPositionSelector', start: 25, end: 30 },
		});
	});

	it('resolves a single character (end omitted)', () => {
		let result = resolveSelectorMap('p:first-of-type 25', 3);
		assert.deepStrictEqual(result, {
			type: 'CssSelector', value: 'p:first-of-type',
			refinedBy: { type: 'TextPositionSelector', start: 28, end: 29 },
		});
	});

	it('resolves sub-range within text node', () => {
		let result = resolveSelectorMap('p:first-of-type 10', 5, 15);
		assert.deepStrictEqual(result, {
			type: 'CssSelector', value: 'p:first-of-type',
			refinedBy: { type: 'TextPositionSelector', start: 15, end: 25 },
		});
	});
});

describe('Snapshot decode: expandSelectorMap', () => {
	let blockSel = 'p:first-of-type';

	it('expands empty string to block selector', () => {
		assert.equal(expandSelectorMap(blockSel, ''), 'p:first-of-type');
	});

	it('expands bare offset', () => {
		assert.equal(expandSelectorMap(blockSel, '25'), 'p:first-of-type 25');
	});

	it('expands zero offset', () => {
		assert.equal(expandSelectorMap(blockSel, '0'), 'p:first-of-type 0');
	});

	it('expands child suffix', () => {
		assert.equal(expandSelectorMap(blockSel, ' > strong'), 'p:first-of-type > strong');
	});

	it('expands child suffix with offset', () => {
		assert.equal(expandSelectorMap(blockSel, ' > em 5'), 'p:first-of-type > em 5');
	});

	it('passes through absolute fallback', () => {
		assert.equal(expandSelectorMap(blockSel, '#my-link'), '#my-link');
	});

	it('expands multi-entry with mixed relative formats', () => {
		let multi = '21 0\n4  > strong\n5 25';
		let expanded = expandSelectorMap(blockSel, multi);
		assert.equal(expanded,
			'21 p:first-of-type 0\n4 p:first-of-type > strong\n5 p:first-of-type 25');
	});
});

let fixturePath = path.resolve(
	import.meta.dirname, '../../fixtures/snapshot/1.json'
);
let fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('Snapshot decode: roundtrip on real fixture data', () => {

	it('all text node anchors have selectorMap', () => {
		function checkBlocks(blocks) {
			for (let block of blocks) {
				if (Array.isArray(block.content)) {
					for (let item of block.content) {
						if (item.text !== undefined && item.anchor) {
							assert.ok('selectorMap' in item.anchor,
								`expected selectorMap, got: ${JSON.stringify(item.anchor)}`);
							assert.ok(!item.anchor.selectorMap.startsWith('/'),
								'snapshot selectorMap should not start with /');
						}
						else if (item.type && Array.isArray(item.content)) {
							checkBlocks([item]);
						}
					}
				}
			}
		}
		checkBlocks(fixture.content);
	});

	it('block anchors have selectorMap with CSS selector', () => {
		for (let block of fixture.content) {
			assert.ok(block.anchor, 'block missing anchor');
			assert.ok(block.anchor.selectorMap !== undefined, 'block anchor should have selectorMap');
		}
	});

	it('expandSelectorMap + resolveSelectorMap produces valid selectors for all text nodes', () => {
		function checkBlocks(blocks) {
			for (let block of blocks) {
				if (!Array.isArray(block.content)) continue;
				let blockSel = block.anchor?.selectorMap || '';
				for (let item of block.content) {
					if (item.text !== undefined && item.anchor?.selectorMap !== undefined) {
						let abs = expandSelectorMap(blockSel, item.anchor.selectorMap);
						let resolved = resolveSelectorMap(abs, 0, item.text.length);
						assert.equal(resolved.type, 'CssSelector');
						assert.ok(resolved.value);
						assert.equal(resolved.refinedBy.type, 'TextPositionSelector');
						assert.ok(resolved.refinedBy.start >= 0);
						assert.ok(resolved.refinedBy.end > resolved.refinedBy.start);
						assert.equal(
							resolved.refinedBy.end - resolved.refinedBy.start,
							item.text.length,
						);
					}
					else if (item.type && Array.isArray(item.content)) {
						checkBlocks([item]);
					}
				}
			}
		}
		checkBlocks(fixture.content);
	});

	it('relative selectorMap formats: empty for sole-child, offset or suffix for others', () => {
		let heading = fixture.content[0];
		let titleNode = heading.content[0];
		assert.equal(titleNode.text, 'Main Title');
		assert.equal(titleNode.anchor.selectorMap, '', 'sole-child should have empty selectorMap');

		let para = fixture.content[1];
		let firstTextNode = para.content[0];
		assert.equal(firstTextNode.text, 'First paragraph with ');
		assert.equal(firstTextNode.anchor.selectorMap, '0');

		let boldNode = para.content[1];
		assert.equal(boldNode.text, 'bold');
		assert.equal(boldNode.anchor.selectorMap, ' > strong');

		let blockSel = para.anchor.selectorMap;
		assert.equal(expandSelectorMap(blockSel, '0'), blockSel + ' 0');
		assert.equal(expandSelectorMap(blockSel, ' > strong'), blockSel + ' > strong');
		assert.equal(expandSelectorMap(blockSel, ''), blockSel);
	});
});

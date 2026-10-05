import { it } from 'node:test';
import assert from 'node:assert/strict';
import { recoveredText } from './helpers.js';

// Saved Reader selections must resolve independently of chunk generation.
const cfi = value => ({ type: 'FragmentSelector',
	conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html', value });
const textRange = (start, end) => ({ type: 'TextPositionSelector', start, end });
const cases = [
	['epub', 'whole element', cfi('epubcfi(/6/2!/4/2)'), 'First Second'],
	['epub', 'text range', cfi('epubcfi(/6/2!/4/2/1,:6,:12)'), 'Second'],
	['snapshot', 'whole element', { type: 'CssSelector', value: '#paragraph' }, 'First Second'],
	['snapshot', 'element-relative range', { type: 'CssSelector', value: '#paragraph',
		refinedBy: textRange(6, 12) }, 'Second'],
	['snapshot', 'body-relative range', textRange(16, 22), 'Second'],
];

for (let [type, name, position, expected] of cases) {
	it(`${type}: resolves an independently supplied ${name}`, () => {
		let structure = {
			metadata: { processor: { type } },
			catalog: { domMap: [{ tag: 'p', id: 'paragraph', index: 0, textStart: 10, textLength: 12 }] },
			content: [{ type: 'paragraph',
				anchor: { selectorMap: type === 'epub' ? '/6/2!/4/2' : '#paragraph' },
				content: [{ text: 'First Second',
					anchor: type === 'epub' ? { selectorMap: '/1' } : { stream: 10 } }],
			}],
		};
		assert.equal(recoveredText(structure, { selectors: JSON.parse(JSON.stringify([position])) }), expected);
	});
}

it('snapshot: recovers container overlap independently of surrounding extracted text', () => {
	const block = (text, stream) => ({ type: 'paragraph', content: [{ text, anchor: { stream } }] });
	for (let header of [false, true]) {
		for (let footer of [false, true]) {
			let structure = {
				metadata: { processor: { type: 'snapshot' } },
				catalog: { domMap: [{ tag: 'div', id: 'container', index: 0, textStart: 8, textLength: 18 }] },
				content: [
					...(header ? [block('Header', 0)] : []),
					block('Alpha', 10), block('Beta', 20),
					...(footer ? [block('Footer', 40)] : []),
				],
			};
			let container = { type: 'CssSelector', value: '#container' };
			for (let [position, expected] of [
				[container, 'Alpha\n\nBeta'],
				[textRange(8, 26), 'Alpha\n\nBeta'],
				[textRange(8, 13), 'Alp'],
				[textRange(22, 26), 'ta'],
				[{ ...container, refinedBy: textRange(0, 5) }, 'Alp'],
				[{ ...container, refinedBy: textRange(14, 18) }, 'ta'],
				[textRange(6, 10), null],
				[textRange(24, 40), null],
				[textRange(15, 20), null],
				[textRange(12, 12), null],
				[textRange(20, 15), null],
				[{ ...container, refinedBy: textRange(0, 19) }, null],
				[{ type: 'CssSelector', value: '#missing' }, null],
			]) {
				assert.equal(recoveredText(structure, { selectors: [position] }), expected,
					`header=${header}, footer=${footer}, ${JSON.stringify(position)}`);
			}
		}
	}
});

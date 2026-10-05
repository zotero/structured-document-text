import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorPositions } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { noOverlap, dom, roundTrip, restore, recoveredText } from './helpers.js';

for (let type of ['epub', 'snapshot']) {
	describe(`${type} positions`, () => {
		it('isolates malformed normalization anchors without dropping text or neighboring chunks', () => {
			for (let deltaMap of [42, '0 invalid']) {
				let structure = dom(['Before', 'Broken', 'After'], type);
				structure.content[1].content[0].anchor.deltaMap = deltaMap;
				structure.catalog.outline = structure.content.map((_, i) => ({ title: `Section ${i}`, ref: [i] }));
				let chunks = getChunks(structure, noOverlap);
				assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, noOverlap));
				assert.equal(chunks.length, 3);
				assert.ok(chunks[0].anchor.selectors.length);
				assert.equal(chunks[1].anchor, null);
				assert.ok(chunks[2].anchor.selectors.length);
			}
		});

		it('keeps selected anchored whitespace between inline runs in one position', () => {
			let structure = dom(['First Second'], type);
			let stream = 0;
			structure.content[0].content = ['First', ' ', 'Second'].map((text, i) => {
				let anchor = type === 'epub' ? { selectorMap: `/${2 * i + 1}` } : { stream };
				stream += text.length;
				return { text, anchor };
			});
			assert.equal(roundTrip(structure)[0].anchor.selectors.length, 1);
			// EPUB keeps a range across synthetic whitespace. Snapshot source
			// offsets still expose a real gap when that whitespace loses its anchor.
			let unanchored = restore(structure);
			delete unanchored.content[0].content[1].anchor;
			assert.equal(roundTrip(unanchored)[0].anchor.selectors.length, type === 'epub' ? 1 : 2);
		});

		it('uses one range for consecutive paragraphs and multiple for omitted content', () => {
			let structure = dom(['First', 'Second', 'Third'], type);
			assert.equal(roundTrip(structure)[0].anchor.selectors.length, 1);
			let excluded = restore(structure);
			excluded.content[1].flowClass = 'excluded';
			let filtered = roundTrip(excluded);
			assert.equal(filtered[0].anchor.selectors.length, 2);
			assert.equal(filtered[0].chunk.text, 'First\n\nThird');
			assert.equal(recoveredText(restore(structure), { selectors: restore(filtered[0].anchor.selectors) }), 'First\n\nThird');
		});

		it('recovers stored positions independently of new splitting options or exclusion flags', () => {
			let structure = dom(['Alpha', 'Beta', 'Gamma'], type, [1]);
			let [{ chunk, positions }] = roundTrip(structure);
			let changed = restore(structure);
			changed.content[0].flowClass = 'excluded';
			delete changed.content[1].flowClass;
			getTextChunks(changed, { maxSize: 3, minSize: 0, overlap: 0 });
			assert.equal(recoveredText(changed, { selectors: positions }), chunk.text);
		});

		it('supports partial nodes, serialized positions, duplicate positions, and repeated text', () => {
			let structure = dom(['Word Word Word'], type);
			for (let { chunk, positions } of roundTrip(structure, { maxSize: 5, minSize: 0, overlap: 0 })) {
				assert.equal(recoveredText(restore(structure), { selectors: [...positions, ...positions] }), chunk.text);
			}
			roundTrip(dom(['X'], type));
		});

		it('omits text without text or element anchors and rejects foreign saved positions', () => {
			let structure = dom(['First', 'Second', 'Third'], type);
			delete structure.content[1].content[0].anchor;
			delete structure.content[1].anchor;
			let [{ chunk }] = roundTrip(structure);
			let { anchor, ...textChunk } = chunk;
			let positions = anchor.selectors;
			assert.equal(chunk.text, 'First\n\nThird');
			assert.equal(positions.length, 2);
			assert.deepEqual(getTextChunks(structure), [textChunk]);
			for (let positions of [null, [], [null], ['bad'], [{ type: 'Unknown' }]]) {
				assert.equal(recoveredText(structure, { selectors: positions }), null);
			}
		});

		it('maps complete synthetic blocks to elements, including mixed anchored text', () => {
			let structure = dom(['Before', 'Image description', 'After'], type);
			delete structure.content[1].content[0].anchor;
			structure.content[1].content.push({ text: ' linked text', anchor: type === 'epub' ? { selectorMap: '/3' } : { stream: 6 } });
			let [{ positions, chunk }] = roundTrip(structure);
			assert.equal(positions.length, 3);
			assert.equal(positions[1].type, type === 'epub' ? 'FragmentSelector' : 'CssSelector');
			assert.equal(positions[1].value, type === 'epub' ? 'epubcfi(/6/2!/4/4,,/3:12)' : '#p1');
			assert.equal(recoveredText(restore(structure), { selectors: restore(positions) }), chunk.text);
			if (type === 'snapshot') {
				assert.equal(recoveredText(structure, { selectors: [{ ...positions[1], refinedBy: null }] }), 'Image description linked text');
			}
		});

		it('locates partial synthetic text at its element even when recovery is broader or ambiguous', () => {
			let structure = dom(['Long image description'], type);
			delete structure.content[0].content[0].anchor;
			let value = type === 'epub' ? 'epubcfi(/6/2!/4/2)' : '#p0';
			for (let { anchor: { selectors: positions } } of getChunks(structure, { maxSize: 10, minSize: 0, overlap: 0 })) {
				assert.equal(positions.length, 1);
				assert.equal(positions[0].value, value);
				assert.equal(recoveredText(structure, { selectors: positions }), 'Long image description');
			}
			let duplicate = restore(structure);
			duplicate.content.push(restore(duplicate.content[0]));
			assert.deepEqual(getChunks(duplicate)[0].anchor.selectors.map(position => position.value), [value, value]);
			let position = type === 'epub' ? { type: 'FragmentSelector', value: 'epubcfi(/6/2!/4/2)' }
				: { type: 'CssSelector', value: '#p0' };
			assert.equal(recoveredText(duplicate, { selectors: [position] }), null);
		});
	});
}

it('splits EPUB positions at content files, not visual pages', () => {
	let structure = dom(['First', 'Second', 'Third'], 'epub');
	structure.content[2].anchor.selectorMap = '/6/4!/4/2';
	structure.catalog.pages = [{ contentRange: [[0], [1]] }, { contentRange: [[1], [2]] }, { contentRange: [[2], [3]] }];
	let [{ positions }] = roundTrip(structure);
	assert.equal(positions.length, 2);
	assert.match(positions[0].value, /^epubcfi\(\/6\/2!/u);
	assert.match(positions[1].value, /^epubcfi\(\/6\/4!/u);
});

it('keeps indexing around an unresolved EPUB selector map and ignores unusable excluded anchors', () => {
	let structure = dom(['Before', 'Broken', 'After', 'Excluded'], 'epub', [3]);
	structure.content[1].content[0].anchor.selectorMap = '1 /1';
	structure.content[3].anchor.selectorMap = 42;
	structure.catalog.outline = structure.content.map((_, i) => ({ title: `Section ${i}`, ref: [i] }));
	let chunks = getChunks(structure, noOverlap);
	assert.equal(chunks.length, 3);
	assert.ok(chunks[0].anchor.selectors.length);
	assert.equal(chunks[1].anchor, null);
	assert.ok(chunks[2].anchor.selectors.length);
});

it('keeps generated snapshot gaps separate but resolves Reader ranges across them', () => {
	let structure = dom(['First', 'Second'], 'snapshot');
	structure.content[1].content[0].anchor.stream = 100;
	assert.equal(roundTrip(structure)[0].anchor.selectors.length, 2);
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 10, end: 104 }] }), 'Seco');
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 0, end: 1000 }] }), 'First\n\nSecond');
	assert.equal(recoveredText(structure, { selectors: [
		{ type: 'TextPositionSelector', start: 0, end: 5 },
		{ type: 'TextPositionSelector', start: 100, end: 106 },
	] }), 'First\n\nSecond');
});

it('resolves partial source ranges inside nested blocks and excludes complete subtrees', () => {
	let structure = dom(['ab', 'cd', 'ef'], 'snapshot');
	structure.content = [{ type: 'list', content: structure.content.map(block => ({ type: 'listitem', content: [block] })) }];
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 1, end: 5 }] }), 'b\n\ncd\n\ne');
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 0, end: 2 }] }), 'ab');
	let excluded = restore(structure);
	excluded.content[0].content[1].reference = true;
	let [{ chunk, positions }] = roundTrip(excluded);
	assert.equal(chunk.text, 'ab\n\nef');
	assert.equal(positions.length, 2);
});

it('keeps NFC and whitespace delta boundaries exact in EPUB and snapshot source offsets', () => {
	for (let type of ['epub', 'snapshot']) {
		let structure = dom(['éx'], type);
		structure.content[0].content[0].anchor.deltaMap = '1 -1';
		if (type === 'epub') structure.content[0].content[0].anchor.selectorMap = '1 /1\n1 /3';
		let [{ positions }] = roundTrip(structure);
		if (type === 'epub') assert.equal(positions[0].value, 'epubcfi(/6/2!/4/2,/1:0,/3:1)');
		else assert.deepEqual(positions, [{ type: 'TextPositionSelector', start: 0, end: 3 }]);
	}
	// Splitting exactly at a merged DOM-node boundary must use the complete
	// original combining sequence, not the normalized character length.
	let structure = dom(['aéx'], 'epub');
	structure.content[0].content[0].anchor = { selectorMap: '2 /1\n1 /3', deltaMap: '2 -1' };
	let parts = roundTrip(structure, { maxSize: 2, minSize: 0, overlap: 0 });
	assert.equal(parts[0].anchor.selectors[0].value, 'epubcfi(/6/2!/4/2/1,:0,:3)');
	assert.equal(parts[1].anchor.selectors[0].value, 'epubcfi(/6/2!/4/2/3,:0,:1)');
});

it('keeps snapshot CSS refinements within their anchor element', () => {
	let structure = dom(['First', 'Second'], 'snapshot');
	structure.catalog.domMap = [
		{ tag: 'p', id: 'p0', index: 0, textStart: 0, textLength: 5 },
		{ tag: 'p', id: 'p1', index: 1, textStart: 5, textLength: 6 },
	];
	for (let refinedBy of [{ type: 'TextPositionSelector', start: 0, end: 11 },
		{ type: 'TextPositionSelector', start: -1, end: 5 }, { type: 'Unknown' }]) {
		assert.equal(recoveredText(structure, { selectors: [{ type: 'CssSelector', value: '#p0', refinedBy }] }), null);
	}
	assert.equal(recoveredText(structure, { selectors: [{ type: 'CssSelector', value: '#p0' }] }), 'First');
	let excluded = restore(structure);
	excluded.content[1].flowClass = 'excluded';
	assert.deepEqual(roundTrip(excluded)[0].anchor.selectors,
		[{ type: 'TextPositionSelector', start: 0, end: 5 }]);
});

it('keeps snapshot text positions independent of implicit table elements and preserves omissions', () => {
	let structure = dom(['First', 'OMIT', 'Second'], 'snapshot', [1]);
	// The extractor can store table > tr while the browser inserts tbody.
	structure.catalog.domMap = [{ tag: 'table', index: 0, textStart: 0, textLength: 15,
		children: [[0, 5], [5, 4], [9, 6]].map(([textStart, textLength], index) =>
			({ tag: 'tr', index, textStart, textLength })),
	}];
	let [{ chunk, positions }] = roundTrip(structure);
	assert.equal(chunk.text, 'First\n\nSecond');
	assert.deepEqual(positions, [
		{ type: 'TextPositionSelector', start: 0, end: 5 },
		{ type: 'TextPositionSelector', start: 9, end: 15 },
	]);
	let normalized = restore(structure);
	let table = normalized.catalog.domMap[0];
	table.children = [{ tag: 'tbody', index: 0, textStart: 0, textLength: 15, children: table.children }];
	assert.deepEqual(getChunks(normalized), [chunk]);
});

it('recovers snapshot CSS through the DOM map when an element spans multiple blocks', () => {
	let structure = dom(['First', 'Second'], 'snapshot');
	structure.content[1].anchor.selectorMap = '#p0';
	structure.catalog.domMap = [{ tag: 'div', id: 'p0', index: 0, textStart: 0, textLength: 11 }];
	assert.equal(recoveredText(structure, { selectors: [{ type: 'CssSelector', value: '#p0' }] }), 'First\n\nSecond');
});

it('uses the same whitespace serialization for inline chunks and restored positions', () => {
	for (let type of ['epub', 'snapshot']) {
		let structure = dom([''], type);
		let stream = 0;
		structure.content[0].content = [' \t', 'A  ', '  ', 'B😀', '\n C ', '\t'].map((text, i) => {
			let anchor = type === 'epub' ? { selectorMap: `/${2 * i + 1}` } : { stream };
			stream += text.length;
			return { text, anchor };
		});
		assert.equal(roundTrip(structure)[0].chunk.text, 'A    B😀\n C');
		for (let { chunk, positions } of roundTrip(structure, { maxSize: 5, minSize: 0, overlap: 1 })) {
			assert.ok(chunk.text.length <= 5 && chunk.text.isWellFormed());
			assert.equal(recoveredText(restore(structure), { selectors: restore(positions) }), chunk.text);
		}
	}
});

it('retains an EPUB source location even when duplicate paths prevent text recovery', () => {
	let structure = dom(['Repeat', 'Repeat'], 'epub');
	structure.content[1].anchor.selectorMap = structure.content[0].anchor.selectorMap;
	let { anchor } = getChunks(structure)[0];
	assert.equal(anchor.selectors.length, 1);
	assert.deepEqual(getAnchorPositions(structure, anchor), anchor.selectors);
	assert.equal(recoveredText(structure, anchor), null);
});

it('recovers EPUB CFIs with escaped assertions or assertions omitted', () => {
	let structure = dom(['Hello world'], 'epub');
	structure.content[0].anchor.selectorMap = '/6/2[chapter^]one]!/4/2';
	roundTrip(structure);
	for (let value of [
		'epubcfi(/6/2!/4/2/1,:0,:5)',
		'epubcfi(/6/2[chapter^]one]!/4/2/1,:0,:5)',
		'epubcfi(/6/2[chapter^]one]!/4/2/1,:0[hello^],world],:5)',
		'epubcfi(/6/2!/4/2/1,:0[^^^[:99],:5[^^^],tail])',
	]) assert.equal(recoveredText(structure, { selectors: [{ type: 'FragmentSelector', value }] }), 'Hello');
});

const epubPosition = value => ({ type: 'FragmentSelector', value });

it('keeps navigable text endpoints around an EPUB image description', () => {
	let structure = whitespaceDocument('epub');
	structure.content.length = 1;
	structure.content[0].content = [{ text: 'Hello ', anchor: { selectorMap: '/1' } },
		{ text: 'diagram' }, { text: ' World', anchor: { selectorMap: '/3' } }];
	let [chunk] = getChunks(structure);
	assert.equal(chunk.anchor.selectors.length, 1);
	assert.equal(chunk.anchor.selectors[0].value, 'epubcfi(/6/2!/4/2,/1:0,/3:6)');
	assert.equal(recoveredText(structure, chunk.anchor), 'Hello diagram World');
});

it('resolves EPUB element ranges and descendant paths through their containing block', () => {
	let structure = whitespaceDocument('epub');
	for (let block of structure.content) for (let node of block.content) delete node.anchor;
	assert.equal(recoveredText(structure, { selectors: [epubPosition('epubcfi(/6/2!/4,/2,/6)')] }),
		'First line\n\nsecond line');
	assert.equal(recoveredText(structure, { selectors: [epubPosition('epubcfi(/6/2!/4/2/99,:0,:4)')] }), 'First line');
	assert.equal(recoveredText(structure, { selectors: [epubPosition('epubcfi(/6/2!/4/20/99,:0,:4)')] }), null);
});

it('still recovers saved snapshot CSS-relative positions after unrelated source text is inserted', () => {
	let structure = whitespaceDocument('snapshot');
	structure.content = [{ type: 'paragraph', anchor: { selectorMap: '#bodytext' },
		content: [{ text: 'Main body.', anchor: { stream: 0 } }] }];
	structure.catalog.domMap = [{ tag: 'p', id: 'bodytext', index: 0, textStart: 0, textLength: 10 }];
	// Older chunks and Reader selections may still supply element-relative CSS.
	let whole = [{ type: 'CssSelector', value: '#bodytext' }];
	let partial = [{ type: 'CssSelector', value: '#bodytext',
		refinedBy: { type: 'TextPositionSelector', start: 0, end: 4 } }];
	assert.equal(recoveredText(structure, { selectors: whole }), 'Main body.');
	assert.equal(recoveredText(structure, { selectors: partial }), 'Main');
	let changed = structuredClone(structure);
	changed.content[0].content[0].anchor.stream = 8;
	changed.catalog.domMap[0].textStart = 8;
	assert.equal(recoveredText(changed, { selectors: whole }), 'Main body.');
	assert.equal(recoveredText(changed, { selectors: partial }), 'Main');
});

it('uses established normalization mapping for source offsets inside collapsed whitespace', () => {
	for (let type of ['epub', 'snapshot']) {
		let structure = whitespaceDocument(type);
		structure.content.length = 1;
		structure.content[0].content = [{ text: 'a b', anchor: {
			...(type === 'epub' ? { selectorMap: '/1' } : { stream: 0 }), deltaMap: '2 -2',
		} }];
		let position = type === 'epub' ? epubPosition('epubcfi(/6/2!/4/2/1,:3,:5)')
			: { type: 'TextPositionSelector', start: 3, end: 5 };
		assert.equal(recoveredText(structure, { selectors: [position] }), 'b');
	}
});

function whitespaceDocument(type, { gap = 0, otherFile = false, excluded = false } = {}) {
	let anchor = (index, stream) => type === 'epub' ? { selectorMap: `/${index}` } : { stream };
	let block = (path, content, extra = {}) => ({ type: 'paragraph', anchor: { selectorMap: path }, content, ...extra });
	let content = [block(type === 'epub' ? '/6/2!/4/2' : '#first', [
		{ text: 'First line', anchor: anchor(1, 0) }, { text: '\n' }, { text: ' ' },
	])];
	if (excluded) content.push(block(type === 'epub' ? '/6/2!/4/4' : '#omit',
		[{ text: 'OMIT', anchor: anchor(1, 10) }], { flowClass: 'excluded' }));
	content.push(block(type === 'epub' ? (otherFile ? '/6/4!/4/2' : '/6/2!/4/6') : '#last',
		[{ text: 'second line', anchor: anchor(1, 10 + gap + (excluded ? 4 : 0)) }]));
	return { metadata: { processor: { type } }, catalog: { outline: [], pages: [] }, content };
}

for (let type of ['epub', 'snapshot']) {
	it(`${type}: bridges synthetic whitespace without losing text`, () => {
		// Keep whitespace within one leaf so trimming does not remove the bridge.
		let structure = whitespaceDocument(type);
		let last = structure.content.pop();
		last.content[0].anchor = type === 'epub' ? { selectorMap: '/3' } : { stream: 10 };
		structure.content[0].content.push(...last.content);
		let [chunk] = getChunks(structure);
		assert.equal(chunk.anchor.selectors.length, 1);
		assert.equal(recoveredText(structure, chunk.anchor), 'First line\n second line');
	});
	it(`${type}: preserves omitted entries when joining positions`, () => {
		let structure = whitespaceDocument(type, { excluded: true });
		let [chunk] = getChunks(structure);
		assert.equal(chunk.anchor.selectors.length, 2);
		assert.equal(recoveredText(structure, chunk.anchor), chunk.text);
		assert.ok(!chunk.text.includes('OMIT'));
	});
}

it('preserves snapshot stream gaps and EPUB content-file boundaries', () => {
	for (let [type, options] of [['snapshot', { gap: 2 }], ['epub', { otherFile: true }]]) {
		let structure = whitespaceDocument(type, options);
		let [chunk] = getChunks(structure);
		assert.equal(chunk.anchor.selectors.length, 2);
		assert.equal(recoveredText(structure, chunk.anchor), chunk.text);
	}
});

it('preserves CSS selector ambiguity when narrowing recovery candidates', () => {
	let structure = {
		metadata: { processor: { type: 'snapshot' } },
		catalog: { outline: [], pages: [], domMap: [
			{ tag: 'p', id: 'same', index: 0, textStart: 0, textLength: 1 },
			{ tag: 'p', id: 'same', index: 1, textStart: 1, textLength: 1 },
		] },
		content: ['A', 'B'].map((text, stream) => ({ type: 'paragraph',
			anchor: { selectorMap: `#block${stream}` }, content: [{ text, anchor: { stream } }] })),
	};
	let read = value => recoveredText(structure, { selectors: [{ type: 'CssSelector', value,
		refinedBy: { type: 'TextPositionSelector', start: 0, end: 1 } }] });
	assert.equal(read('#same'), null);
	assert.equal(read('p'), null);
	assert.equal(read('body > p:first-child'), 'A');
	assert.equal(read('body > P:nth-child(2)'), 'B');
});

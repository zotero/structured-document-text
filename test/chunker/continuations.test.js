import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorPositions } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { recoveredText } from './helpers.js';

const options = { maxSize: 200, minSize: 0, overlap: 0 };

function document(texts, type = 'snapshot') {
	let stream = 0;
	let content = texts.map((text, page) => {
		let anchor;
		if (type === 'pdf') {
			let runs = Array.from(text, (char, x) => /\s/u.test(char) ? [] : [[0, page, x, 0, x + 1, 1]]).flat();
			anchor = { textMap: JSON.stringify(runs) };
		}
		else anchor = type === 'epub' ? { selectorMap: '/1' } : { stream };
		stream += text.length;
		return { type: 'paragraph', content: [{ text, anchor }],
			anchor: type === 'pdf' ? { pageRects: [[page, 0, 0, text.length, 1]] }
				: { selectorMap: type === 'epub' ? `/6/2!/4/${2 * (page + 1)}` : `#p${page}` } };
	});
	return { metadata: { processor: { type } }, content,
		catalog: { pages: content.map((_, i) => ({ contentRange: [[i], [i + 1]] })), outline: [] } };
}

function link(structure, first, next) {
	structure.content[first].nextPart = [next];
	structure.content[next].previousPart = [first];
}

function roundTrip(structure, settings = options) {
	let chunks = getChunks(structure, settings);
	assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, settings));
	for (let chunk of chunks) {
		assert.equal(recoveredText(JSON.parse(JSON.stringify(structure)), JSON.parse(JSON.stringify(chunk.anchor))), chunk.text);
	}
	return chunks;
}

for (let type of ['pdf', 'epub', 'snapshot']) {
	it(`${type}: keeps linked preformatted parts on separate lines`, () => {
		for (let texts of [['if ready:', '    run()'], ['if ready:\n', '    run()'], ['if ready:', '\n    run()']]) {
			let structure = document(texts, type);
			for (let block of structure.content) block.type = 'preformatted';
			link(structure, 0, 1);
			let [chunk] = roundTrip(structure);
			assert.equal(chunk.text, 'if ready:\n    run()');
		}
	});

	it(`${type}: joins three continued parts while keeping ordinary paragraphs separate`, () => {
		let structure = document(['The results', 'demonstrate that', 'the method works.', 'Another paragraph.'], type);
		link(structure, 0, 1);
		link(structure, 1, 2);
		let [chunk] = roundTrip(structure);
		assert.equal(chunk.text, 'The results demonstrate that the method works.\n\nAnother paragraph.');
		assert.equal(chunk.embedText, chunk.text);
		if (type === 'pdf') assert.deepEqual(getAnchorPositions(structure, chunk.anchor).map(position => position.pageIndex), [0, 1, 2, 3]);
	});

	it(`${type}: continues body text across an auxiliary passage and folds it in after`, () => {
		let structure = document(['The results', 'A footnote.', 'show an improvement.', 'Another paragraph.'], type);
		link(structure, 0, 2);
		structure.content[1].flowClass = 'auxiliary';
		let [chunk] = roundTrip(structure, options);
		assert.equal(chunk.text, 'The results show an improvement.\n\nA footnote.\n\nAnother paragraph.');
		if (type === 'pdf') {
			assert.deepEqual(getAnchorPositions(structure, chunk.anchor).map(position => position.pageIndex).sort(), [0, 1, 2, 3]);
		}
	});

	it(`${type}: splits a section with its captions inline as one group`, () => {
		let texts = ['Alpha one. Alpha two. Alpha three.', 'A separate caption.',
			'Beta one. Beta two. Beta three.', 'Another caption.'];
		let structure = document(texts, type);
		structure.content[1].flowClass = structure.content[3].flowClass = 'auxiliary';
		let chunks = roundTrip(structure, { maxSize: 35, minSize: 0, overlap: 0 });
		assert.ok(chunks.length > 1);
		assert.equal(chunks.map(chunk => chunk.text).join(' ').replace(/\s+/gu, ' '), texts.join(' '));
		assert.deepEqual(chunks.map(chunk => chunk.sectionPart), chunks.map((_, i) => i + 1));
		assert.ok(chunks.every(chunk => chunk.sectionParts === chunks.length));
	});
}

it('uses either explicit continuation link and preserves one space after trimming block edges', () => {
	for (let direction of ['nextPart', 'previousPart']) {
		let structure = document(['First  ', '  second']);
		if (direction === 'nextPart') structure.content[0].nextPart = [1];
		else structure.content[1].previousPart = [0];
		assert.equal(roundTrip(structure)[0].text, 'First second');
	}
});

it('recognizes nested block references and whitespace-only edge nodes', () => {
	let structure = document(['First', 'second']);
	structure.content[0].content.push({ text: ' \n' });
	structure.content[1].content.unshift({ text: '\n ' });
	structure.content[0].nextPart = [0, 1];
	structure.content[1].previousPart = [0, 0];
	structure.content = [{ type: 'blockquote', content: structure.content }];
	assert.equal(roundTrip(structure)[0].text, 'First second');
});

it('splits a continued paragraph at sentences instead of its physical block boundary', () => {
	let structure = document(['First sentence. The results demonstrate', 'that the method works. Another sentence.']);
	link(structure, 0, 1);
	let chunks = roundTrip(structure, { maxSize: 50, minSize: 0, overlap: 0 });
	assert.equal(chunks[0].text, 'First sentence.');
	assert.equal(chunks.map(chunk => chunk.text).join(' '),
		'First sentence. The results demonstrate that the method works. Another sentence.');
});

it('does not follow a continuation chain through an excluded part', () => {
	let structure = document(['First', 'OMITTED', 'Last']);
	link(structure, 0, 1);
	link(structure, 1, 2);
	structure.content[1].flowClass = 'excluded';
	assert.equal(roundTrip(structure)[0].text, 'First\n\nLast');
});

it('joins directly linked selected parts without pulling intervening excluded text into the chunk', () => {
	let structure = document(['First', 'HEADER', 'last']);
	link(structure, 0, 2);
	structure.content[1].flowClass = 'excluded';
	assert.equal(roundTrip(structure)[0].text, 'First last');
});

it('keeps paragraph separation when a recovered selection omits text at either linked block edge', () => {
	for (let omittedAtEnd of [false, true]) {
		let texts = omittedAtEnd ? ['First OMITTED', 'Second'] : ['First', 'OMITTED Second'];
		let structure = document(texts);
		link(structure, 0, 1);
		let positions = [{ type: 'TextPositionSelector', start: 0, end: 5 },
			{ type: 'TextPositionSelector', start: texts[0].length + (omittedAtEnd ? 0 : 8),
				end: texts[0].length + texts[1].length }];
		assert.equal(recoveredText(structure, { selectors: positions }), 'First\n\nSecond');
	}
	let structure = document(['First OMITTED', 'Second']);
	structure.content[0].content = [{ text: 'First', anchor: { stream: 0 } }, { text: ' OMITTED', anchor: { stream: 5 } }];
	link(structure, 0, 1);
	assert.equal(recoveredText(structure, { selectors: [{ type: 'TextPositionSelector', start: 0, end: 5 },
		{ type: 'TextPositionSelector', start: 13, end: 19 }] }), 'First\n\nSecond');
});

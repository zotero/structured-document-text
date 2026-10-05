import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { getTextChunks, getChunkCount } from '../../src/chunker/text.js';
import { splitText } from '../../src/chunker/split.js';
import { estimateTokens } from '../../src/chunker/chunks.js';
import { discoverFixtures } from '../helpers.js';
import { noOverlap, paragraph, document, textDocument, pdf, pdfBlock, dom, roundTrip, restore, recoveredText } from './helpers.js';

describe('chunk splitting', () => {
	it('skips unusable outline entries and retains valid descendants', () => {
		let content = [paragraph('Heading', { type: 'heading' }), paragraph('Body text')];
		for (let title of [undefined, null, 42, {}, '   ']) {
			let structure = textDocument(content, { outline: [null, false, [], { title, ref: [0],
				children: [{ title: 'Child', ref: [1], children: 'invalid' }] }] });
			let chunks = getTextChunks(structure, noOverlap);
			assert.deepEqual(chunks.map(chunk => [chunk.text, chunk.outlinePath]), [['Heading', ''], ['Body text', 'Child']]);
		}
		for (let ref of [[], [-1], [0.5], ['0'], [null], [Infinity], {}]) {
			let structure = textDocument(content, { outline: [{ title: 'Parent', ref,
				children: [{ title: 'Child', ref: [1] }] }] });
			assert.deepEqual(getTextChunks(structure, noOverlap).map(chunk => chunk.outlinePath), ['', 'Parent > Child']);
		}
		assert.equal(getTextChunks(textDocument(content, { outline: {} }), noOverlap)[0].text, 'Heading\n\nBody text');
	});

	it('suppresses only matching headings whose body consists entirely of references', () => {
		let heading = paragraph('References', { type: 'heading' });
		let outline = [{ title: 'References', ref: [0] }, { title: 'Following', ref: [2] }];
		for (let body of [paragraph('Citation', { reference: true }),
			{ type: 'blockquote', reference: true, content: [paragraph('Citation')] },
			{ type: 'blockquote', content: [paragraph(' \n'), paragraph('Citation', { reference: true })] }]) {
			let structure = textDocument([heading, body, paragraph('Following body')], { outline });
			assert.deepEqual(getTextChunks(structure, noOverlap).map(chunk => chunk.text), ['Following body']);
		}
		let structure = textDocument([heading, paragraph('Citation')], { outline: outline.slice(0, 1) });
		assert.equal(getTextChunks(structure, noOverlap)[0].text, 'Citation');
		let headingOnly = textDocument([heading], { outline: outline.slice(0, 1) });
		assert.equal(getTextChunks(headingOnly, noOverlap)[0].text, 'References');
		let unmatched = textDocument([heading, paragraph('Citation', { reference: true })],
			{ outline: [{ title: 'Different heading', ref: [0] }] });
		assert.equal(getTextChunks(unmatched, noOverlap)[0].text, 'References');
	});

	it('suppresses reference-only headings regardless of auxiliary block order', () => {
		for (let referenceFirst of [false, true]) {
			for (let nested of [false, true]) {
				let texts = ['References', ...(referenceFirst ? ['Citation', 'Footnote'] : ['Footnote', 'Citation']), 'Following'];
				let structure = textDocument(texts.map(text => paragraph(text)));
				structure.content[0].type = structure.content[3].type = 'heading';
				structure.content[referenceFirst ? 1 : 2].reference = true;
				let auxiliary = referenceFirst ? 2 : 1;
				if (nested) structure.content[auxiliary] = { type: 'blockquote', content: [structure.content[auxiliary]] };
				structure.content[auxiliary].flowClass = 'auxiliary';
				structure.catalog.outline = [{ title: 'References', ref: [0] }, { title: 'Following', ref: [3] }];
				let chunks = getTextChunks(structure, noOverlap);
				assert.deepEqual(chunks.map(chunk => chunk.text), ['Footnote', 'Following']);
			}
		}
	});

	it('keeps main-body classification separate from auxiliary interruptions', () => {
		for (let anchored of [false, true]) {
			let structure = textDocument([
				paragraph('References', { type: 'heading' }), paragraph('Citation', { reference: true }),
				paragraph('Footnote', { flowClass: 'auxiliary' }), paragraph('Ordinary body'),
			], { outline: [{ title: 'References', ref: [0] }] });
			if (!anchored) {
				delete structure.content[3].anchor;
				delete structure.content[3].content[0].anchor;
			}
			// The body after the heading keeps the section from reading as
			// references only, anchored or not; the footnote between them
			// keeps its place
			let chunks = getTextChunks(structure, noOverlap);
			assert.deepEqual(chunks.map(chunk => chunk.text), anchored ? ['Footnote\n\nOrdinary body'] : ['Footnote']);
			assert.equal(chunks[0].embedText, anchored ? 'References\n\nFootnote\n\nOrdinary body' : 'References\n\nFootnote');
		}
		let structure = textDocument([paragraph('Heading', { type: 'heading' }),
			paragraph('Auxiliary citation', { flowClass: 'auxiliary', reference: true })],
		{ outline: [{ title: 'Heading', ref: [0] }] });
		assert.deepEqual(getTextChunks(structure, noOverlap).map(chunk => chunk.text), ['Heading']);
	});

	it('keeps standalone headings around excluded furniture and whitespace-only references', () => {
		for (let nested of [false, true]) {
			let texts = ['Preface', 'Running header', '12', ' \n', 'Introduction', 'Actual introduction'];
			let structure = textDocument(texts.map(text => paragraph(text)));
			structure.content[0].type = structure.content[4].type = 'heading';
			structure.content[1].reference = structure.content[3].reference = true;
			for (let i of [1, 2]) {
				if (nested) structure.content[i] = { type: 'blockquote', content: [structure.content[i]] };
				structure.content[i].flowClass = 'excluded';
			}
			structure.catalog.outline = [{ title: 'Preface', ref: [0] }, { title: 'Introduction', ref: [4] }];
			assert.deepEqual(getTextChunks(structure, noOverlap).map(chunk => chunk.text), ['Preface', 'Actual introduction']);
		}
	});

	it('keeps headings with unanchored ordinary body, including mixed reference sections', () => {
		for (let type of ['pdf', 'epub', 'snapshot']) {
			for (let body of [['Unmapped'], ['Citation', 'Unmapped'], ['Unmapped', 'Citation']]) {
				let texts = ['Preface', ...body, 'Introduction', 'Actual introduction'];
				let structure = type === 'pdf' ? pdf(texts.map((text, i) => pdfBlock(text, 0, 0, i * 2))) : dom(texts, type);
				let following = texts.length - 2;
				structure.content[0].type = structure.content[following].type = 'heading';
				for (let [i, text] of texts.entries()) {
					if (text === 'Unmapped') {
						delete structure.content[i].anchor;
						delete structure.content[i].content[0].anchor;
					}
					if (text === 'Citation') structure.content[i] = {
						type: 'blockquote', reference: true, content: [structure.content[i]],
					};
				}
				structure.catalog.outline = [{ title: 'Preface', ref: [0] }, { title: 'Introduction', ref: [following] }];
				let expected = ['Preface', 'Actual introduction'];
				assert.deepEqual(getTextChunks(structure, noOverlap).map(chunk => chunk.text), expected);
				assert.deepEqual(roundTrip(structure, noOverlap).map(({ chunk }) => chunk.text), expected);
			}
		}
	});

	it('preserves preformatted indentation, inline whitespace nodes and splitting boundaries', () => {
		let code = '    if ready:\n\t    run()\n\n    finish()  \n';
		let structure = textDocument([{ type: 'blockquote', content: [{ type: 'preformatted',
			content: [{ text: '    ' }, { text: code.slice(4, -3) }, { text: '  \n' }] }] }]);
		for (let maxSize of [100, 24, 12]) {
			let chunks = roundTrip(structure, { maxSize, minSize: 0, overlap: 0 }).map(({ chunk }) => chunk);
			assert.equal(chunks.map(chunk => chunk.text).join(''), code);
			assert.ok(chunks.every(chunk => /\S/u.test(chunk.text)));
			assert.ok(chunks.every(chunk => chunk.text.length <= maxSize));
		}
		assert.equal(getTextChunks(structure, noOverlap)[0].text, code);
		let mixed = textDocument([paragraph('  Before  '), structure.content[0], paragraph('  After  ')]);
		assert.equal(roundTrip(mixed, noOverlap)[0].chunk.text, `Before\n\n${code}\n\nAfter`);
	});

	it('omits whitespace-only slices at tiny budgets without losing source text or positions', () => {
		let code = ' \tabc\n\n def \n';
		let structures = ['pdf', 'epub', 'snapshot'].map(type => {
			let structure = type === 'pdf' ? pdf([pdfBlock(code)]) : dom([code], type);
			structure.content[0].type = 'preformatted';
			return structure;
		});
		structures.push(textDocument([{ type: 'blockquote', content: [{ type: 'preformatted',
			content: [{ text: code.slice(0, 2) }, { text: code.slice(2, -2) }, { text: code.slice(-2) }] }] }]));
		for (let structure of structures) {
			let isPDF = structure.metadata.processor.type === 'pdf';
			for (let options of [{ maxSize: 2, minSize: 0, overlap: 0 }, { maxSize: 3, minSize: 0, overlap: 1 }]) {
				let chunks = getChunks(structure, options);
				assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, options));
				if (!options.overlap) {
					assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\s/gu, ''), code.replace(/\s/gu, ''));
				}
				else {
					assert.deepEqual(chunks.map(chunk => chunk.text), [' \ta', 'abc', 'c\n', '\n d', 'def', 'f \n']);
				}
				for (let [i, chunk] of chunks.entries()) {
					assert.ok(/\S/u.test(chunk.text) && chunk.text.length <= options.maxSize);
					assert.ok(chunk.anchor);
					let recovered = recoveredText(structure, restore(chunk.anchor));
					assert.equal(isPDF ? recovered.trim() : recovered, isPDF ? chunk.text.trim() : chunk.text);
					assert.equal(chunk.sectionPart, i + 1);
					assert.equal(chunk.sectionParts, chunks.length);
				}
			}
		}
	});

	for (let type of ['pdf', 'epub']) {
		it(`${type}: preserves preformatted layout and maps split code back to its glyphs`, () => {
			let code = '    if ready:\n\t    run()\n\n    finish()  \n';
			let structure = type === 'pdf' ? pdf([pdfBlock(code)]) : dom([code], type);
			let block = structure.content[0];
			block.type = 'preformatted';
			if (type === 'pdf') {
				let runs = [], x = 0, y = 100;
				for (let char of code) {
					if (char === '\n') { x = 0; y -= 2; continue; }
					if (char !== ' ' && char !== '\t') runs.push([0, 0, x, y, x + 1, y + 1]);
					x++;
				}
				block.anchor.pageRects = [[0, 0, 0, 20, 101]];
				block.content[0].anchor.textMap = JSON.stringify(runs);
			}
			for (let maxSize of [100, 24, 12]) {
				let options = { maxSize, minSize: 0, overlap: 0 };
				let chunks = getChunks(structure, options);
				assert.equal(chunks.map(chunk => chunk.text).join(''), code);
				assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure, options));
				for (let chunk of chunks) {
					assert.ok(chunk.text.length <= maxSize);
					assert.ok(/\S/u.test(chunk.text), 'Do not embed a whitespace-only slice');
					assert.ok(chunk.anchor);
					let recovered = recoveredText(structure, restore(chunk.anchor));
					assert.equal(typeof recovered, 'string');
					assert.ok(code.includes(recovered));
					assert.equal(type === 'pdf' ? recovered.trim() : recovered,
						type === 'pdf' ? chunk.text.trim() : chunk.text);
				}
			}
		});
	}

	it('keeps ordinary outline targets and nested paragraphs in the source text', () => {
		let structure = textDocument([paragraph('Introduction'), { type: 'blockquote', content: [paragraph('Nested'), paragraph('Body')] }],
			{ outline: [{ title: 'First', ref: [0], children: [{ title: 'Second', ref: [1, 0] }] }] });
		let chunks = getTextChunks(structure, { ...noOverlap, minSize: 0 });
		assert.deepEqual(chunks.map(p => p.text), ['Introduction', 'Nested\n\nBody']);
		assert.equal(chunks[1].outlinePath, 'First > Second');
	});

	it('folds auxiliary passages into the body and leaves excluded and reference blocks out', () => {
		let structure = textDocument([
			paragraph('Header', { flowClass: 'excluded' }), paragraph('Body'),
			{ type: 'blockquote', flowClass: 'excluded', content: [paragraph('Hidden child')] },
			paragraph('Reference', { reference: true }), paragraph('Caption', { flowClass: 'auxiliary' }),
		]);
		assert.deepEqual(getTextChunks(structure).map(chunk => chunk.text), ['Body\n\nCaption']);
		assert.equal(getChunkCount(structure), 1);
	});

	it('sizes the actual text, traverses every piece of a large block, and preserves coverage', () => {
		for (let text of ['Go! '.repeat(5000), 'a'.repeat(501), '😀'.repeat(2001), '前文。 後文！ '.repeat(100)]) {
			let structure = textDocument([paragraph(text)]);
			let pieces = getTextChunks(structure, { maxSize: 51, minSize: 10, overlap: 0 });
			assert.ok(pieces.length > 1);
			for (let piece of pieces) {
				assert.ok(piece.text.length <= 51);
				assert.ok(piece.text.isWellFormed());
			}
			assert.equal(pieces.map(piece => piece.text.replace(/\s/gu, '')).join(''), text.replace(/\s/gu, ''));
			assert.deepEqual(pieces, getTextChunks(structure, { maxSize: 51, minSize: 10, overlap: 0 }));
		}
	});

	it('uses sentence context beyond the chunk limit when an abbreviation reaches it', () => {
		let text = 'Start. We saw e.g. examples here. Last sentence.';
		for (let maxSize of [17, 20]) {
			let chunks = roundTrip(dom([text], 'snapshot'), { maxSize, minSize: 0, overlap: 0 });
			assert.equal(chunks[0].chunk.text, 'Start.');
			assert.equal(chunks.map(({ chunk }) => chunk.text).join(' '), text);
		}
	});

	it('recognizes Unicode sentence punctuation and closing quotation marks', () => {
		for (let [text, maxSize, first] of [
			['مرحبا؟ الجملة التالية طويلة جدا. النهاية.', 15, 'مرحبا؟'],
			['One sentence!» Next sentence continues for a while.', 22, 'One sentence!»'],
		]) {
			let chunks = roundTrip(dom([text], 'snapshot'), { maxSize, minSize: 0, overlap: 0 });
			assert.equal(chunks[0].chunk.text, first);
			assert.equal(chunks.map(({ chunk }) => chunk.text).join(' '), text);
		}
	});

	it('overlaps within a section without stalling, even with surrogate pairs', () => {
		for (let text of ['abc '.repeat(50), '😀'.repeat(30), 'Word.                    Long ending.']) {
			let pieces = [...splitText(text, 10, 0, 9)];
			assert.ok(pieces.length < text.length);
			assert.ok(pieces.some((p, i) => i && p.start < pieces[i - 1].end));
			for (let [i, piece] of pieces.entries()) {
				assert.ok(text.slice(piece.start, piece.end).isWellFormed());
				if (i) {
					assert.ok(piece.start > pieces[i - 1].start);
					assert.ok(piece.end > pieces[i - 1].end);
				}
			}
		}
	});

	it('advances beyond the previous sentence when overlap exceeds the minimum size', () => {
		let text = 'Short one. ' + 'Long text '.repeat(20);
		let chunks = getTextChunks(textDocument([paragraph(text)]), { maxSize: 60, minSize: 0, overlap: 30 });
		assert.equal(chunks[0].text, 'Short one.');
		let ranges = [...splitText(text, 60, 0, 30)];
		for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i].end > ranges[i - 1].end);
		assert.equal(ranges.at(-1).end, text.trimEnd().length);
	});

	it('handles empty text and rejects invalid configurations', () => {
		assert.deepEqual(getTextChunks(textDocument([])), []);
		assert.deepEqual(getTextChunks(textDocument([paragraph(' \n\t ')])), []);
		for (let options of [{ maxSize: 1 }, { minSize: -1 }, { maxSize: 2400, overlap: 2400 }, { overlap: -1 },
			{ maxSize: Infinity }, { maxSize: 2400, minSize: 2401 }, { overlap: 0.5 },
			{ maxTokens: 1 }, { maxTokens: 2.5 }, { maxTokens: Infinity }, { maxTokens: 459, maxSize: 1000 }]) {
			for (let get of [getTextChunks, getChunkCount]) {
				assert.throws(() => get(textDocument([]), options), TypeError);
			}
		}
	});
});

describe('chunk counts', () => {
	for (let { format, name, data } of discoverFixtures()) {
		it(`${format}/${name}: counts text and anchored chunks with the same options`, () => {
			for (let options of [undefined, { maxTokens: 120 },
				{ maxSize: 2400, minSize: 450, overlap: 180 },
				{ maxSize: 500, minSize: 0, overlap: 0 }]) {
				let count = getChunkCount(data, options);
				let where = JSON.stringify(options);
				assert.equal(count, getTextChunks(data, options).length, `Text count: ${where}`);
				assert.equal(count, getChunks(data, options).length, `Anchored count: ${where}`);
			}
		});
	}

	it('counts empty and whitespace-only documents, including tiny preformatted slices', () => {
		for (let type of ['pdf', 'epub', 'snapshot']) {
			for (let texts of [[], [' \n\t '], [' \tabc\n\n def \n']]) {
				let structure = type === 'pdf' ? pdf(texts.map(text => pdfBlock(text))) : dom(texts, type);
				for (let block of structure.content) block.type = 'preformatted';
				for (let options of [{ maxSize: 2, minSize: 0, overlap: 0 }, { maxSize: 3, minSize: 0, overlap: 1 }]) {
					let count = getChunkCount(structure, options);
					assert.equal(count, getTextChunks(structure, options).length);
					assert.equal(count, getChunks(structure, options).length);
					if (texts.length === 0 || !texts[0].trim()) assert.equal(count, 0);
				}
			}
		}
	});

	it('keeps chunks whose source geometry cannot produce an anchor in the count', () => {
		let structure = pdf([pdfBlock('Body '.repeat(30))]);
		structure.content[0].content[0].anchor.textMap = 'not valid JSON';
		let chunks = getChunks(structure, noOverlap);
		assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.anchor === null));
		assert.equal(getChunkCount(structure, noOverlap), chunks.length);
		assert.equal(getChunkCount(structure, noOverlap), getTextChunks(structure, noOverlap).length);
	});

	it('counts without decoding source geometry or reading page metadata', t => {
		let structure = pdf([pdfBlock('Body '.repeat(30))]);
		let block = structure.content[0], textMap = block.content[0].anchor.textMap;
		let parse = JSON.parse;
		t.mock.method(JSON, 'parse', (...args) => {
			assert.notEqual(args[0], textMap, 'Count must not decode PDF text geometry');
			return parse(...args);
		});
		for (let [object, key] of [[block.anchor, 'pageRects'], [structure.catalog, 'pages']]) {
			Object.defineProperty(object, key, { get() { throw new Error(`Count accessed ${key}`); } });
		}
		assert.ok(getChunkCount(structure, noOverlap) > 1);
	});
});

describe('passage metadata', () => {
	for (let type of ['pdf', 'epub', 'snapshot']) {
		it(`${type}: folds captions into the group of their section`, () => {
			let texts = ['Before', 'First caption', 'Second caption', 'After'];
			let structure = type === 'pdf' ? pdf(texts.map((text, i) => pdfBlock(text, 0, 0, i * 10))) : dom(texts, type);
			structure.content[1].flowClass = structure.content[2].flowClass = 'auxiliary';
			structure.catalog.outline = [{ title: 'First', ref: [0] }, { title: 'Last', ref: [3] }];
			let chunks = roundTrip(structure).map(({ chunk }) => chunk);
			assert.deepEqual(chunks.map(chunk => chunk.text), ['Before\n\nFirst caption\n\nSecond caption\n\nAfter']);
			assert.ok(chunks.every(chunk => chunk.sectionPart === 1 && chunk.sectionParts === 1));
			assert.deepEqual(chunks.map(({ anchor, ...chunk }) => chunk), getTextChunks(structure));
		});
	}

	it('inherits auxiliary classification through containers and numbers the split group', () => {
		let structure = textDocument([
			paragraph('Before'),
			{ type: 'blockquote', flowClass: 'auxiliary', content: [paragraph('Caption '.repeat(30)), paragraph('Continuation')] },
			paragraph('After'),
		]);
		let chunks = getTextChunks(structure, { maxSize: 50, minSize: 10, overlap: 0 });
		assert.ok(chunks.length > 1);
		assert.deepEqual(chunks.map(chunk => chunk.sectionPart), chunks.map((_, i) => i + 1));
		assert.ok(chunks.every(chunk => chunk.sectionParts === chunks.length));
		assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\s/gu, ''),
			'Before' + 'Caption'.repeat(30) + 'Continuation' + 'After');
	});

	it('numbers combined short sections as one group and counts embedding context in token estimates', () => {
		let structure = textDocument([paragraph('Body '.repeat(20)), paragraph('1234567890')], {
			outline: [{ title: '1234', ref: [0] }, { title: '5678', ref: [1] }],
		});
		let chunks = getTextChunks(structure, { maxSize: 80, minSize: 60, overlap: 0 });
		assert.ok(chunks.length > 1);
		assert.deepEqual(chunks.map(chunk => chunk.sectionPart), chunks.map((_, i) => i + 1));
		assert.ok(chunks.every(chunk => chunk.sectionParts === chunks.length));
		for (let chunk of chunks) assert.equal(chunk.tokens, Math.round(estimateTokens(chunk.embedText)));
		assert.ok(chunks.some(chunk => chunk.tokens > Math.round(estimateTokens(chunk.text))));
	});

	it('uses the first selected PDF page label, with page ordinals as fallback', () => {
		let structure = pdf([pdfBlock('First', 0), pdfBlock('Second', 1)]);
		structure.catalog.pages[0].label = 'iv';
		assert.equal(getChunks(structure)[0].pageLabel, 'iv');
		let excluded = restore(structure);
		excluded.content[0].flowClass = 'excluded';
		assert.equal(getTextChunks(excluded)[0].pageLabel, '2');
	});

	it('resolves labels inside multi-page blocks at text offsets without decoding geometry', () => {
		let block = pdfBlock('abcd');
		block.anchor.pageRects.push([1, 0, 0, 2, 1]);
		block.content[0].anchor.textMap = 'not decoded by text chunking';
		let structure = document([block], 'pdf', { pages: [
			{ label: 'iv', contentRange: [[0], [0, 0, 2]] },
			{ label: '1', contentRange: [[0, 0, 2], [1]] },
		] });
		assert.deepEqual(getTextChunks(structure, { maxSize: 2, minSize: 0, overlap: 0 }).map(chunk => chunk.pageLabel), ['iv', '1']);
	});

	it('returns physical EPUB page labels but does not present synthetic locations as pages', () => {
		let structure = dom(['First', 'Second'], 'epub', [0]);
		structure.catalog.pageMappingType = 'physical';
		structure.catalog.pages = [{ label: 'v', contentRange: [[0], [1]] }, { label: 'A-3', contentRange: [[1], [2]] }];
		assert.equal(getChunks(structure)[0].pageLabel, 'A-3');
		let locations = restore(structure);
		locations.catalog.pageMappingType = 'locations';
		assert.equal(getChunks(locations)[0].pageLabel, null);
		assert.equal(getChunks(dom(['Unpaginated'], 'snapshot'))[0].pageLabel, null);
	});
});

describe('embedding context and heading selection', () => {
	for (let type of ['pdf', 'epub', 'snapshot']) {
		it(`${type}: groups short bodies without counting their replacement headings`, () => {
			let title = 'A heading that puts section over the minimum';
			let first = 'word '.repeat(112).trim(), second = 'word '.repeat(200).trim();
			let texts = [title, first, 'Next', second];
			let structure = type === 'pdf' ? pdf(texts.map((text, i) => pdfBlock(text, i))) : dom(texts, type);
			structure.content[0].type = structure.content[2].type = 'heading';
			structure.catalog.outline = [{ title, ref: [0] }, { title: 'Next', ref: [2] }];
			let chunks = roundTrip(structure);
			assert.equal(chunks.length, 1);
			assert.equal(chunks[0].chunk.text, first + '\n\n' + second);
			assert.equal(chunks[0].chunk.embedText, title + '\n\n' + first + '\n\nNext\n\n' + second);
			assert.equal(chunks[0].positions.length, 2);
			assert.ok(estimateTokens(chunks[0].chunk.embedText) <= 768);
		});
	}

	it('uses body size for explicit grouping limits while retaining headings without replacement context', () => {
		for (let title of ['A heading', 'A heading too long to add as context']) {
			let first = 'a'.repeat(15), second = 'b'.repeat(30);
			let structure = dom([title, first, 'Next', second], 'snapshot');
			structure.content[0].type = structure.content[2].type = 'heading';
			structure.catalog.outline = [{ title, ref: [0] }, { title: 'Next', ref: [2] }];
			let chunks = roundTrip(structure, { maxSize: 100, minSize: 20, overlap: 0 });
			assert.equal(chunks.length, 1);
			let retained = title.length > 25 ? title + '\n\n' : '';
			assert.equal(chunks[0].chunk.text, retained + first + '\n\n' + second);
			assert.equal(chunks[0].chunk.embedText, title + '\n\n' + first + '\n\nNext\n\n' + second);
			assert.ok(chunks[0].chunk.embedText.length <= 100);
			assert.equal(roundTrip(structure, { maxSize: 100, minSize: 0, overlap: 0 }).length, 2);
		}
	});

	for (let type of ['pdf', 'epub', 'snapshot']) {
		it(`${type}: replaces matching headings with paths and excludes their source locations`, () => {
			let texts = ['Methods', 'We collected samples.', 'Results', 'We found three patterns.'];
			let structure = type === 'pdf' ? pdf(texts.map((text, i) => pdfBlock(text, i))) : dom(texts, type);
			structure.content[0].type = structure.content[2].type = 'heading';
			structure.catalog.outline = [{ title: 'Study', children: [
				{ title: 'Methods', ref: [0] }, { title: 'Results', ref: [2] },
			] }];
			let [{ chunk, positions }] = roundTrip(structure, { maxSize: 400, minSize: 100, overlap: 0 });
			assert.equal(chunk.text, 'We collected samples.\n\nWe found three patterns.');
			assert.equal(chunk.embedText, 'Study > Methods\n\nWe collected samples.\n\nStudy > Results\n\nWe found three patterns.');
			assert.equal(chunk.outlinePath, 'Study > Methods');
			assert.equal(positions.length, 2);
			if (type === 'pdf') assert.deepEqual(positions.map(position => position.pageIndex), [1, 3]);
		});
	}

	it('matches complete nested headings across inline nodes with normalized whitespace', () => {
		let structure = textDocument([{ type: 'blockquote', content: [
			{ type: 'heading', content: [{ text: ' Methods  ' }, { text: '\nand setup ' }] }, paragraph('Body'),
		] }], { outline: [{ title: 'Methods and setup', ref: [0, 0] }] });
		assert.deepEqual(getTextChunks(structure, noOverlap).map(({ text, embedText, outlinePath }) => [text, embedText, outlinePath]),
			[['Body', 'Methods and setup\n\nBody', 'Methods and setup']]);
	});

	it('keeps unmatched headings and ordinary or container outline targets', () => {
		for (let [block, title] of [
			[paragraph('Methods and limitations', { type: 'heading' }), 'Methods'],
			[paragraph('Methods'), 'Methods'],
			[{ type: 'blockquote', content: [paragraph('Methods', { type: 'heading' })] }, 'Methods'],
			[paragraph('Methods', { type: 'heading' }), null],
		]) {
			let structure = textDocument([block, paragraph('Body')], {
				outline: title ? [{ title, ref: [0] }] : [],
			});
			let [chunk] = getTextChunks(structure, noOverlap);
			let source = block.type === 'blockquote' ? 'Methods' : block.content[0].text;
			assert.equal(chunk.text, source + '\n\nBody');
			assert.equal(chunk.embedText, (title ? title + '\n\n' : '') + chunk.text);
		}
	});

	it('keeps headings when their paths exceed the context allowance', () => {
		let title = 'A very long section heading';
		let structure = dom([title, 'Body'], 'snapshot');
		structure.content[0].type = 'heading';
		structure.catalog.outline = [{ title, ref: [0] }];
		let [{ chunk }] = roundTrip(structure, noOverlap);
		assert.equal(chunk.text, title + '\n\nBody');
		assert.equal(chunk.embedText, chunk.text);
	});

	it('keeps only the first path when combined context exceeds a quarter of the budget', () => {
		let structure = dom(['Methods', 'Body one.', 'Results', 'Body two.'], 'snapshot');
		structure.content[0].type = structure.content[2].type = 'heading';
		structure.catalog.outline = [{ title: 'Study', children: [
			{ title: 'Methods', ref: [0] }, { title: 'Results', ref: [2] },
		] }];
		let [{ chunk, positions }] = roundTrip(structure, { maxSize: 100, minSize: 50, overlap: 0 });
		assert.equal(chunk.text, 'Body one.\n\nResults\n\nBody two.');
		assert.equal(chunk.embedText, 'Study > Methods\n\n' + chunk.text);
		assert.equal(positions[0].start, 'Methods'.length);
	});

	it('reserves the sum of context paths in the complete embedding input', () => {
		let structure = dom(['Methods', 'word '.repeat(12), 'Results', 'word '.repeat(40)], 'snapshot');
		structure.content[0].type = structure.content[2].type = 'heading';
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }, { title: 'Results', ref: [2] }];
		let chunks = roundTrip(structure, { maxSize: 100, minSize: 75, overlap: 10 }).map(({ chunk }) => chunk);
		assert.ok(chunks.length > 1);
		for (let chunk of chunks) {
			assert.ok(chunk.text.length <= 82);
			assert.ok(chunk.embedText.length <= 100);
			assert.ok(chunk.embedText.startsWith(chunk.outlinePath + '\n\n'));
			assert.ok(!/Methods|Results/u.test(chunk.text));
		}
	});

	it('repeats context for continuation chunks while mapping only their body text', () => {
		let structure = dom(['Methods', 'word '.repeat(100)], 'snapshot');
		structure.content[0].type = 'heading';
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }];
		let chunks = roundTrip(structure, { maxSize: 80, minSize: 0, overlap: 10 });
		assert.ok(chunks.length > 1);
		for (let { chunk, positions } of chunks) {
			assert.equal(chunk.embedText, 'Methods\n\n' + chunk.text);
			assert.ok(chunk.embedText.length <= 80);
			assert.ok(positions.every(position => position.start >= 'Methods'.length));
		}
	});

	it('shares context for adjacent identical paths without repeating or dropping the body', () => {
		let structure = dom(['Methods', 'First body', 'Methods', 'Second body'], 'snapshot');
		structure.content[0].type = structure.content[2].type = 'heading';
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }, { title: 'Methods', ref: [2] }];
		let [{ chunk }] = roundTrip(structure, { maxSize: 100, minSize: 50, overlap: 0 });
		assert.equal(chunk.text, 'First body\n\nSecond body');
		assert.equal(chunk.embedText, 'Methods\n\n' + chunk.text);
	});

	it('retains a heading-only section with its own source anchor', () => {
		let structure = dom(['Methods'], 'snapshot');
		structure.content[0].type = 'heading';
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }];
		let [{ chunk }] = roundTrip(structure);
		assert.equal(chunk.text, 'Methods');
		assert.equal(chunk.embedText, 'Methods');
	});

	it('drops context rather than violating an explicit minimum or overlap', () => {
		let structure = dom(['Methods', 'Body'], 'snapshot');
		structure.content[0].type = 'heading';
		structure.catalog.outline = [{ title: 'Methods', ref: [0] }];
		for (let options of [{ minSize: 100, overlap: 0 }, { minSize: 0, overlap: 99 }]) {
			let [{ chunk }] = roundTrip(structure, { maxSize: 100, ...options });
			assert.equal(chunk.text, 'Methods\n\nBody');
			assert.equal(chunk.embedText, chunk.text);
		}
	});
});

it('recognizes CJK sentence boundaries without requiring inter-sentence whitespace', () => {
	let structure = textDocument([paragraph('前文。後文。終文。')]);
	assert.deepEqual(getTextChunks(structure, { maxSize: 7, minSize: 0, overlap: 0 }).map(p => p.text),
		['前文。後文。', '終文。']);
});

it('validates custom minimum and overlap against the automatic script budget', () => {
	for (let options of [{ minSize: 3000 }, { overlap: 3000 }]) {
		let cjk = textDocument([paragraph('前文'.repeat(10000))]);
		let latin = textDocument([paragraph('a '.repeat(10000))]);
		for (let get of [getTextChunks, getChunkCount]) assert.throws(() => get(cjk, options), TypeError);
		let chunks = getTextChunks(latin, options);
		assert.ok(chunks.length);
		assert.equal(getChunkCount(latin, options), chunks.length);
	}
});

it('groups small outline sections and skips empty sections without losing inline whitespace', () => {
	let structure = textDocument([paragraph(' '), { type: 'paragraph', content: [{ text: 'A  ' }, { text: ' B' }] }, paragraph(' C ')]);
	structure.catalog.outline = ['Empty', 'A', 'B', 'C'].map((title, i) => ({ title, ref: [[0], [1], [1, 1], [2]][i] }));
	assert.deepEqual(getTextChunks(structure, { maxSize: 10, minSize: 10, overlap: 0 })
		.map(({ text, embedText, outlinePath }) => [text, embedText, outlinePath]), [['A   B\n\nC', 'A   B\n\nC', 'A']]);
});

it('uses smaller automatic chunks for CJK while explicit character limits are script-independent', () => {
	let latin = textDocument([paragraph('a'.repeat(5000))]);
	let cjk = textDocument([paragraph('文'.repeat(5000))]);
	assert.ok(getTextChunks(cjk).length > getTextChunks(latin).length);
	assert.deepEqual(getTextChunks(latin, { maxSize: 500 }).map(chunk => chunk.text.length),
		getTextChunks(cjk, { maxSize: 500 }).map(chunk => chunk.text.length));
});

it('reserves outline context in automatic and explicit embedding budgets', () => {
	let plain = textDocument([paragraph('word '.repeat(3000))]);
	let titled = restore(plain);
	titled.catalog.outline = [{ title: 'Context '.repeat(40), ref: [0] }];
	for (let chunk of getTextChunks(titled)) {
		assert.equal(chunk.embedText, titled.catalog.outline[0].title + '\n\n' + chunk.text);
		assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7);
	}
	// A path above a quarter of the explicit budget is omitted.
	assert.deepEqual(getTextChunks(titled, { maxSize: 500 }).map(c => c.text), getTextChunks(plain, { maxSize: 500 }).map(c => c.text));
	titled = restore(plain);
	titled.catalog.outline = [{ title: 'Context', ref: [0] }];
	assert.ok(getTextChunks(titled, { maxSize: 500 }).every(c => c.text.length <= 491 && c.embedText.length <= 500));
});

it('uses the first selected outline path when a merged group splits across sections', () => {
	let structure = dom(['abc', 'defghijklmnopqrstuvwxyz'], 'snapshot');
	structure.catalog.outline = [{ title: 'First', ref: [0] }, { title: 'Second', ref: [1] }];
	let chunks = roundTrip(structure, { maxSize: 10, minSize: 6, overlap: 0 }).map(result => result.chunk);
	assert.equal(chunks[0].outlinePath, 'First');
	assert.ok(chunks.slice(1).every(chunk => chunk.outlinePath === 'Second'));
	assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\s/gu, ''), 'abcdefghijklmnopqrstuvwxyz');
});

it('joins a short trailing section to the preceding group', () => {
	let structure = dom(['a'.repeat(60), 'end'], 'snapshot');
	structure.catalog.outline = [{ title: 'First', ref: [0] }, { title: 'Last', ref: [1] }];
	let chunks = roundTrip(structure, { maxSize: 100, minSize: 50, overlap: 0 });
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].chunk.text, 'a'.repeat(60) + '\n\nend');
});

it('does not repeat text across a paragraph boundary', () => {
	let paragraphs = ['alpha beta gamma', 'delta epsilon zeta'];
	let chunks = roundTrip(dom(paragraphs, 'snapshot'), { maxSize: 25, minSize: 5, overlap: 8 });
	assert.deepEqual(chunks.map(result => result.chunk.text), paragraphs);
});

it('balances the final pair of chunks instead of leaving a short tail', () => {
	let text = 'one two three four five six seven';
	let chunks = getTextChunks(textDocument([paragraph(text)]), { maxSize: 30, minSize: 4, overlap: 0 });
	assert.equal(chunks.length, 2);
	assert.ok(chunks.every(chunk => chunk.text.length >= 10 && chunk.text.length <= 30));
	assert.equal(chunks.map(chunk => chunk.text).join(' '), text);
});

it('balances a section across all remaining chunks while preserving paragraphs', () => {
	let paragraphs = Array.from({ length: 11 }, (_, i) => String.fromCharCode(65 + i).repeat(600));
	let chunks = roundTrip(dom(paragraphs, 'snapshot')).map(({ chunk }) => chunk);
	assert.deepEqual(chunks.map(chunk => chunk.text.split('\n\n').length), [4, 4, 3]);
	assert.equal(chunks.map(chunk => chunk.text).join('\n\n'), paragraphs.join('\n\n'));
});

it('splits an earlier sentence instead of leaving a tiny final paragraph', () => {
	let body = Array(68).fill('The results provide useful scientific evidence.').join(' ');
	let tail = 'Funding was provided by the research council.';
	let chunks = roundTrip(dom([body, tail], 'snapshot')).map(result => result.chunk);
	assert.equal(chunks.length, 2);
	assert.ok(chunks.every(chunk => estimateTokens(chunk.embedText) >= 120 && estimateTokens(chunk.embedText) <= 768));
	assert.ok(chunks.at(-1).text.endsWith('\n\n' + tail));
});

it('keeps overlap within its requested size at surrogate-pair boundaries', () => {
	let chunks = getTextChunks(textDocument([paragraph('ab😀😀cd')]), { maxSize: 6, minSize: 0, overlap: 3 });
	assert.deepEqual(chunks.map(p => p.text), ['ab😀😀', '😀cd']);
	let ranges = [...splitText('ab😀😀cd', 6, 0, 3)];
	assert.ok(ranges[0].end - ranges[1].start <= 3);
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { spawnSync } from 'node:child_process';
import { noOverlap, paragraph, textDocument, pdf, pdfBlock, dom, restore, recoveredText } from './helpers.js';

it('has minimal text-only exports and a stable chunk shape', async () => {
	assert.deepEqual(getTextChunks(textDocument([paragraph('Body')])), [{ text: 'Body', embedText: 'Body', tokens: 1,
		outlinePath: '', pageLabel: null, sectionPart: 1, sectionParts: 1 }]);
	assert.deepEqual(Object.keys(await import('../../src/chunker/text.js')).sort(), ['CHUNKER_VERSION', 'getChunkCount', 'getPlainTextChunks', 'getTextChunks']);
	assert.deepEqual(Object.keys(await import('../../src/chunker/index.js')).sort(),
		['CHUNKER_VERSION', 'getAnchorContent', 'getAnchorPositions', 'getChunkCount', 'getChunks', 'getPlainTextChunks']);
	assert.ok(!('getChunks' in await import('../../src/read.js')));
	assert.ok(!('getChunks' in await import('../../src/index.js')));
	assert.ok(!('getTextChunks' in await import('../../src/read.js')));
	assert.ok(!('getTextChunks' in await import('../../src/index.js')));
});

it('loads only text chunking dependencies without decoding textMaps', t => {
	let structure = pdf([pdfBlock('Body')]);
	let textMap = structure.content[0].content[0].anchor.textMap = 'not valid JSON';
	let decodes = 0, parse = JSON.parse;
	t.mock.method(JSON, 'parse', (...args) => {
		if (args[0] === textMap) decodes++;
		return parse(...args);
	});
	assert.equal(getTextChunks(structure)[0].text, 'Body');
	assert.equal(decodes, 0);
	// A fresh process verifies the import graph, independently of this file's
	// explicit import of chunker/index above.
	let result = spawnSync(process.execPath, ['--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		import { registerHooks } from 'node:module';
		let modules = new Set();
		registerHooks({ resolve(specifier, context, next) {
			let result = next(specifier, context);
			modules.add(result.url);
			return result;
		} });
		await import('./src/chunker/text.js');
		for (let url of modules) {
			assert.ok(!url.includes('/src/pdf/') && !url.includes('/src/dom/'), url);
			for (let name of ['index', 'anchors', 'pdf', 'epub', 'snapshot', 'dom']) {
				assert.ok(!url.endsWith('/src/chunker/' + name + '.js'), url);
			}
		}
	`], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
});

it('rejects unsupported processors when generating source positions', () => {
	for (let texts of [[], [''], ['Body']]) {
		let structure = dom(texts, 'snapshot');
		structure.metadata.processor.type = 'unknown';
		assert.throws(() => getChunks(structure), /Unsupported SDT processor type/);
	}
});

it('returns self-contained chunks that survive serialization', () => {
	for (let structure of [pdf([pdfBlock('First', 0), pdfBlock('Second', 1)]),
		dom(['First', 'Second'], 'epub'), dom(['First', 'Second'], 'snapshot')]) {
		for (let chunk of getChunks(structure, noOverlap)) {
			assert.deepEqual(Object.keys(chunk).sort(), ['anchor', 'embedText', 'outlinePath', 'pageLabel',
				'sectionPart', 'sectionParts', 'text', 'tokens']);
			let saved = restore(chunk);
			assert.equal(recoveredText(restore(structure), saved.anchor), saved.text);
		}
	}
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverFixtures } from './helpers.js';
import { openStructuredDocumentTextPack } from '../src/pack/reader.js';
import { packStructuredDocumentText } from '../src/pack/writer.js';
import {
	decodeIndex,
	getContentStart,
	HEADER_SIZE,
	readHeader,
} from '../src/pack/format.js';
import { encodeContentChunk, getBlockBytesFromContentChunk } from '../src/pack/chunk.js';
import { writeU32LE } from '../src/pack/bytes.js';

const fixtures = discoverFixtures();

describe('SDTPack', () => {
	for (const { format, name, data } of fixtures) {
		describe(`${format}/${name}`, () => {
			it('roundtrips through materialize()', async () => {
				let structure = packableFixture(data);
				let buffer = packQuiet(structure);
				let reader = await openStructuredDocumentTextPack(buffer);
				assert.deepEqual(await reader.materialize(), structure);
			});

			it('reads top-level blocks lazily', async () => {
				let structure = packableFixture(data);
				let buffer = packQuiet(structure);
				let reader = await openStructuredDocumentTextPack(buffer);
				let indexes = sampleIndexes(structure.content.length);
				for (let index of indexes) {
					assert.deepEqual(await reader.getBlock([index]), structure.content[index]);
				}
			});

			it('reads nested refs lazily', async () => {
				let structure = packableFixture(data);
				let ref = findNestedRef(structure.content);
				if (!ref) {
					return;
				}
				let buffer = packQuiet(structure);
				let reader = await openStructuredDocumentTextPack(buffer);
				assert.deepEqual(await reader.getBlock(ref), getNodeByRef(structure.content, ref));
			});

			it('reads page blocks from contentRanges', async () => {
				let structure = packableFixture(data);
				let buffer = packQuiet(structure);
				let reader = await openStructuredDocumentTextPack(buffer);
				for (let pageIndex of sampleIndexes(structure.catalog.pages?.length || 0)) {
					assert.deepEqual(await readExpectedPageBlocks(reader, structure, pageIndex), getExpectedPageBlocks(structure, pageIndex));
				}
			});
		});
	}

	it('supports destructive packing', async () => {
		let original = packableFixture(fixtures[0].data);
		let input = clone(original);
		let buffer = packQuiet(input, { destructive: true });
		assert.equal(input.content.length, original.content.length);
		assert(input.content.every(block => block === null));
		let reader = await openStructuredDocumentTextPack(buffer);
		assert.deepEqual(await reader.materialize(), original);
	});

	it('supports empty catalog and content', async () => {
		let structure = {
			schemaVersion: '1.0.0',
			metadata: {
				processor: { type: 'snapshot', version: '1.0.0' },
				dateCreated: '2000-01-01T00:00:00.000Z',
				source: {
					contentType: 'text/html',
					hash: '00000000000000000000000000000000',
					properties: {},
				},
			},
			catalog: {
				pages: [],
				outline: [],
			},
			content: [],
		};
		let buffer = packQuiet(structure);
		let reader = await openStructuredDocumentTextPack(buffer);
		assert.deepEqual(await reader.getCatalog(), structure.catalog);
		assert.deepEqual(await reader.materialize(), structure);
	});

	it('writes the fixed binary header layout', () => {
		let structure = createTinyStructure();
		let buffer = packQuiet(structure);
		let bytes = new Uint8Array(buffer);
		let header = readHeader(bytes.subarray(0, HEADER_SIZE));

		assert.deepEqual(
			Array.from(bytes.subarray(0, 8)),
			[0x89, 0x53, 0x44, 0x54, 0x0d, 0x0a, 0x1a, 0x0a]
		);
		assert.equal(bytes[8], 1, 'pack version');
		assert.deepEqual(Array.from(bytes.subarray(9, 12)), [1, 0, 0], 'schema version bytes');
		assert.equal(readTestU32LE(bytes, 12), header.indexLength);
		assert.deepEqual(
			Array.from(bytes.subarray(12, 16)),
			[
				header.indexLength & 0xff,
				(header.indexLength >>> 8) & 0xff,
				(header.indexLength >>> 16) & 0xff,
				(header.indexLength >>> 24) & 0xff,
			],
			'indexLength is u32le'
		);
	});

	it('writes a decodable index with section lengths and sentinel entries', () => {
		let structure = createTinyStructure();
		let buffer = packQuiet(structure);
		let bytes = new Uint8Array(buffer);
		let header = readHeader(bytes.subarray(0, HEADER_SIZE));
		let indexBytes = bytes.subarray(HEADER_SIZE, HEADER_SIZE + header.indexLength);
		let index = decodeIndex(indexBytes);
		let contentLength = bytes.byteLength - getContentStart(header, index);

		assert.equal(header.indexLength, 8 + index.chunkByteOffsets.length * 8);
		assert.ok(index.metadataLength > 0);
		assert.ok(index.catalogLength > 0);
		assert.deepEqual(index.chunkBlockStarts, [0, structure.content.length]);
		assert.deepEqual(index.chunkByteOffsets, [0, contentLength]);
		assert.equal(getContentStart(header, index) + index.chunkByteOffsets[1], bytes.byteLength);
	});

	it('encodes content chunk block offsets as little-endian u32 values', () => {
		let encoder = new TextEncoder();
		let decoder = new TextDecoder();
		let blockByteArrays = [
			encoder.encode('a'),
			encoder.encode('bc'),
			encoder.encode('{"type":"paragraph"}'),
		];
		let chunk = encodeContentChunk(blockByteArrays);

		assert.equal(readTestU32LE(chunk, 0), 0);
		assert.equal(readTestU32LE(chunk, 4), blockByteArrays[0].byteLength);
		assert.equal(readTestU32LE(chunk, 8), blockByteArrays[0].byteLength + blockByteArrays[1].byteLength);
		for (let i = 0; i < blockByteArrays.length; i++) {
			assert.equal(
				decoder.decode(getBlockBytesFromContentChunk(chunk, blockByteArrays.length, i)),
				decoder.decode(blockByteArrays[i])
			);
		}
	});

	it('uses bounded byte-source reads for random access', async () => {
		let structure = packableFixture(fixtures[0].data);
		let buffer = packQuiet(structure);
		let source = createTrackedByteSource(buffer);
		let header = readHeader(new Uint8Array(buffer).subarray(0, HEADER_SIZE));
		let reader = await openStructuredDocumentTextPack(source);

		assert.deepEqual(source.reads[0], { offset: 0, length: HEADER_SIZE });
		assert.deepEqual(source.reads[1], { offset: HEADER_SIZE, length: header.indexLength });
		assert.equal(source.reads.length, 2);
		assertNoFullFileReads(source);

		source.clearReads();
		assert.equal((await reader.getMetadata()).processor.type, structure.metadata.processor.type);
		assert.equal(source.reads.length, 1);
		assertNoFullFileReads(source);

		source.clearReads();
		assert.deepEqual(await reader.getCatalog(), structure.catalog);
		assert.equal(source.reads.length, 1);
		assertNoFullFileReads(source);

		source.clearReads();
		assert.deepEqual(await reader.getBlock([0]), structure.content[0]);
		assert.equal(source.reads.length, 1);
		assertNoFullFileReads(source);

		source.clearReads();
		assert.deepEqual(await readExpectedPageBlocks(reader, structure, 0), getExpectedPageBlocks(structure, 0));
		assert.ok(source.reads.length >= 1);
		assertNoFullFileReads(source);

		source.clearReads();
		assert.deepEqual(await reader.materialize(), structure);
		assert.ok(source.reads.length >= 1);
		assertNoFullFileReads(source);
	});

	it('supports disk-backed byte sources with positional reads', async () => {
		let structure = packableFixture(fixtures.find(({ format }) => format === 'pdf')?.data || fixtures[0].data);
		let buffer = packQuiet(structure);
		let tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdtpack-'));
		let filePath = path.join(tmpDir, 'document.sdt');
		let file;
		try {
			await fs.writeFile(filePath, new Uint8Array(buffer));
			file = await fs.open(filePath, 'r');
			let { size } = await file.stat();
			let source = createFileByteSource(file, size);
			let reader = await openStructuredDocumentTextPack(source);
			assertNoFullFileReads(source);

			source.clearReads();
			assert.deepEqual(await reader.getMetadata(), structure.metadata);
			assert.equal(source.reads.length, 1);
			assertNoFullFileReads(source);

			source.clearReads();
			assert.deepEqual(await reader.getCatalog(), structure.catalog);
			assert.equal(source.reads.length, 1);
			assertNoFullFileReads(source);

			source.clearReads();
			assert.deepEqual(await reader.getBlock([0]), structure.content[0]);
			assert.equal(source.reads.length, 1);
			assertNoFullFileReads(source);

			source.clearReads();
			assert.deepEqual(await reader.materialize(), structure);
			assert.ok(source.reads.length >= 1);
			assertNoFullFileReads(source);
		}
		finally {
			await file?.close();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it('rejects missing source hashes', () => {
		let structure = packableFixture(fixtures[0].data);
		structure.metadata.source.hash = '';
		assert.throws(
			() => packStructuredDocumentText(structure),
			/metadata\.source\.hash/
		);
	});

	it('rejects missing creation timestamps', () => {
		let structure = packableFixture(fixtures[0].data);
		delete structure.metadata.dateCreated;
		assert.throws(
			() => packStructuredDocumentText(structure),
			/metadata\.dateCreated/
		);
	});

	it('rejects non-major-minor-patch processor versions', () => {
		let structure = packableFixture(fixtures[0].data);
		structure.metadata.processor.version = '1.0.0-draft';
		assert.throws(
			() => packStructuredDocumentText(structure),
			/metadata\.processor\.version/
		);
	});

	it('warns but roundtrips oversized top-level blocks', async () => {
		let structure = {
			schemaVersion: '1.0.0',
			metadata: {
				processor: { type: 'snapshot', version: '1.0.0' },
				dateCreated: '2000-01-01T00:00:00.000Z',
				source: {
					contentType: 'text/html',
					hash: '00000000000000000000000000000000',
					properties: {},
				},
			},
			catalog: {
				pages: [{ contentRanges: [[[0], [0, 0]]] }],
				outline: [],
			},
			content: [
				{
					type: 'paragraph',
					content: [{ text: 'x'.repeat(70 * 1024) }],
				},
			],
		};
		let warnings = captureWarnings(() => {
			packStructuredDocumentText(structure);
		});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /oversized top-level blocks/);
		let buffer = packQuiet(structure);
		let reader = await openStructuredDocumentTextPack(buffer);
		assert.deepEqual(await reader.materialize(), structure);
	});

	it('rejects malformed magic and version', async () => {
		let buffer = packQuiet(packableFixture(fixtures[0].data));
		let badMagic = new Uint8Array(buffer.slice(0));
		badMagic[0] = 0;
		await assert.rejects(() => openStructuredDocumentTextPack(badMagic), /magic/);

		let badVersion = new Uint8Array(buffer.slice(0));
		badVersion[8] = 2;
		await assert.rejects(() => openStructuredDocumentTextPack(badVersion), /version/);
	});

	it('rejects invalid header index lengths', async () => {
		let buffer = packQuiet(packableFixture(fixtures[0].data));
		let bytes = new Uint8Array(buffer.slice(0));
		writeU32LE(bytes, 12, 0);
		await assert.rejects(() => openStructuredDocumentTextPack(bytes), /index length/);

		bytes = new Uint8Array(buffer.slice(0));
		writeU32LE(bytes, 12, 8 + 8 * Math.ceil(bytes.byteLength / 8));
		await assert.rejects(() => openStructuredDocumentTextPack(bytes), /index bounds/);
	});

	it('rejects invalid relative chunk offsets', async () => {
		let buffer = packQuiet(packableFixture(fixtures[0].data));
		let corrupted = rewriteIndex(buffer, (indexBytes) => {
			writeU32LE(indexBytes, 8, 1);
		});
		await assert.rejects(() => openStructuredDocumentTextPack(corrupted), /first chunk offset/);
	});

	it('rejects index layouts outside the file', async () => {
		let buffer = packQuiet(packableFixture(fixtures[0].data));
		let corrupted = rewriteIndex(buffer, (indexBytes) => {
			writeU32LE(indexBytes, 0, 0xffffffff);
		});
		await assert.rejects(() => openStructuredDocumentTextPack(corrupted), /outside file/);
	});
});

function sampleIndexes(length) {
	if (!length) {
		return [];
	}
	return [...new Set([0, Math.floor(length / 2), length - 1])];
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function packableFixture(value) {
	return clone(value);
}

function createTinyStructure() {
	return {
		schemaVersion: '1.0.0',
		metadata: {
			processor: { type: 'snapshot', version: '1.0.0' },
			dateCreated: '2000-01-01T00:00:00.000Z',
			source: {
				contentType: 'text/html',
				hash: '00000000000000000000000000000000',
				properties: {},
			},
		},
		catalog: {
			pages: [{ contentRanges: [[[0], [1]]] }],
			outline: [],
		},
		content: [
			{
				type: 'paragraph',
				content: [{ text: 'First' }],
			},
			{
				type: 'paragraph',
				content: [{ text: 'Second' }],
			},
		],
	};
}

function readTestU32LE(bytes, offset) {
	return (bytes[offset]
		+ bytes[offset + 1] * 0x100
		+ bytes[offset + 2] * 0x10000
		+ bytes[offset + 3] * 0x1000000) >>> 0;
}

function createTrackedByteSource(buffer) {
	let bytes = new Uint8Array(buffer);
	return {
		byteLength: bytes.byteLength,
		reads: [],
		async read(offset, length) {
			this.reads.push({ offset, length });
			return bytes.subarray(offset, offset + length);
		},
		clearReads() {
			this.reads.length = 0;
		},
	};
}

function createFileByteSource(file, byteLength) {
	return {
		byteLength,
		reads: [],
		async read(offset, length) {
			this.reads.push({ offset, length });
			let buffer = Buffer.allocUnsafe(length);
			let { bytesRead } = await file.read(buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead);
		},
		clearReads() {
			this.reads.length = 0;
		},
	};
}

function assertNoFullFileReads(source) {
	for (let read of source.reads) {
		assert.notEqual(read.length, source.byteLength);
	}
}

function rewriteIndex(buffer, update) {
	let bytes = new Uint8Array(buffer.slice(0));
	let header = readHeader(bytes.subarray(0, HEADER_SIZE));
	let indexBytes = bytes.subarray(HEADER_SIZE, HEADER_SIZE + header.indexLength);
	update(indexBytes);
	return bytes;
}

function findNestedRef(content) {
	for (let i = 0; i < content.length; i++) {
		let ref = findNestedRefInNode(content[i], [i]);
		if (ref) {
			return ref;
		}
	}
	return null;
}

function findNestedRefInNode(node, ref) {
	if (!node || typeof node !== 'object' || !Array.isArray(node.content)) {
		return null;
	}
	for (let i = 0; i < node.content.length; i++) {
		let childRef = [...ref, i];
		if (childRef.length > 1) {
			return childRef;
		}
		let nested = findNestedRefInNode(node.content[i], childRef);
		if (nested) {
			return nested;
		}
	}
	return null;
}

function getNodeByRef(content, ref) {
	let node = { content };
	for (let index of ref) {
		node = node.content[index];
	}
	return node;
}

function getExpectedPageBlocks(structure, pageIndex) {
	let page = structure.catalog.pages?.[pageIndex];
	if (!page || !Array.isArray(page.contentRanges)) {
		return [];
	}
	let intervals = [];
	for (let range of page.contentRanges) {
		let start = range?.[0]?.[0];
		let end = range?.[1]?.[0];
		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			continue;
		}
		if (end >= start) {
			intervals.push([start, end]);
		}
	}
	intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let blocks = [];
	let lastEnd = -1;
	for (let [start, end] of intervals) {
		start = Math.max(start, lastEnd + 1);
		for (let i = start; i <= end; i++) {
			blocks.push(structure.content[i]);
		}
		lastEnd = Math.max(lastEnd, end);
	}
	return blocks;
}

async function readExpectedPageBlocks(reader, structure, pageIndex) {
	let page = structure.catalog.pages?.[pageIndex];
	if (!page || !Array.isArray(page.contentRanges)) {
		return [];
	}
	let blocks = [];
	let lastEnd = -1;
	for (let [start, end] of getPageTopLevelBlockIntervals(page)) {
		start = Math.max(start, lastEnd + 1);
		blocks.push(...await reader.getBlocks(start, end));
		lastEnd = Math.max(lastEnd, end);
	}
	return blocks;
}

function getPageTopLevelBlockIntervals(page) {
	let intervals = [];
	for (let range of page.contentRanges) {
		let start = range?.[0]?.[0];
		let end = range?.[1]?.[0];
		if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
			continue;
		}
		intervals.push([start, end]);
	}
	intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return intervals;
}

function captureWarnings(fn) {
	let originalWarn = console.warn;
	let warnings = [];
	console.warn = (...args) => {
		warnings.push(args.join(' '));
	};
	try {
		fn();
	}
	finally {
		console.warn = originalWarn;
	}
	return warnings;
}

function packQuiet(structure, options) {
	let result;
	captureWarnings(() => {
		result = packStructuredDocumentText(structure, options);
	});
	return result;
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localOriginalToNFC } from '../../src/chunker/dom.js';

describe('deltamap: localOriginalToNFC', () => {
	it('keeps unnormalized offsets within their entry', () => {
		for (let [original, normalized] of [[-1, 0], [0, 0], [2, 2], [4, 3]]) {
			assert.equal(localOriginalToNFC(undefined, 5, original, 3), normalized);
		}
	});

	it('maps original combining sequences and collapsed whitespace to NFC boundaries', () => {
		// Original "café \n bar" becomes "café bar": é consumes two original
		// characters and the following normalized space consumes three.
		for (let [original, normalized] of [[3, 3], [4, 4], [5, 4], [6, 5], [7, 5], [8, 5], [11, 8]]) {
			assert.equal(localOriginalToNFC('4 -1 5 -3', 0, original, 8), normalized);
		}
	});

	it('uses local offsets for a later entry in a merged text node', () => {
		// The entry "ééz" starts at NFC offset 2 in "éxééz". Its offsets must
		// exclude the earlier entry's normalization shift.
		for (let [original, normalized] of [[0, 0], [1, 1], [2, 1], [3, 2], [4, 2], [5, 3]]) {
			assert.equal(localOriginalToNFC('1 -1 3 -2 4 -3', 2, original, 3), normalized);
		}
	});
});

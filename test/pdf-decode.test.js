import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunData, reconstructCharPositions, visitCharPositions } from '../src/pdf/decode.js';

it('reconstructs positions in source order for every direction and soft-hyphen flag', () => {
	for (let header = 0; header < 16; header++) {
		let vertical = !!(header & 2);
		let run = [header, 3, 10, 20, 50, 80, 2, [3, 4], -1, 0];
		let expected = vertical
			? [{ x1: 20, x2: 22 }, { x1: 25, x2: 29 }, { x1: 29, x2: 28 }, { x1: 28, x2: 28 }]
			: [{ x1: 10, x2: 12 }, { x1: 15, x2: 19 }, { x1: 19, x2: 18 }, { x1: 18, x2: 18 }];
		assert.deepEqual(reconstructCharPositions(run), expected);
		let kept = header & 1 ? expected.slice(0, -1) : expected;
		assert.deepEqual(buildRunData([run]), kept.map(({ x1, x2 }) => ({
			rect: vertical ? [10, x1, 50, x2] : [x1, 20, x2, 80], pageIndex: 3, vertical,
		})));
	}
});

it('uses the bounding box for single glyphs, retaining soft hyphens only in raw positions', () => {
	for (let header = 0; header < 16; header++) {
		let vertical = !!(header & 2);
		let run = [header, 2, 10, 20, 50, 80];
		assert.deepEqual(reconstructCharPositions(run), vertical ? [{ x1: 20, x2: 80 }] : [{ x1: 10, x2: 50 }]);
		assert.deepEqual(buildRunData([run]), header & 1 ? [] : [{ rect: [10, 20, 50, 80], pageIndex: 2, vertical }]);
	}
});

it('preserves non-finite raw advances while filtering them from run data', () => {
	let run = [0, 0, 1, 2, 10, 5, 2, NaN, 3];
	assert.deepEqual(reconstructCharPositions(run), [{ x1: 1, x2: 3 }, { x1: 3, x2: NaN }, { x1: NaN, x2: NaN }]);
	assert.deepEqual(buildRunData([run]), [{ rect: [1, 2, 3, 5], pageIndex: 0, vertical: false }]);
});

it('preserves raw iterable inputs and the existing caller-specific input guards', () => {
	let run = [0, 0, 1, 2, 3, 4];
	assert.deepEqual(reconstructCharPositions(new Float64Array(run)), [{ x1: 1, x2: 3 }]);
	for (let value of [null, undefined, [], [0, 0, 1, 2, 3]]) assert.deepEqual(reconstructCharPositions(value), []);
	assert.deepEqual(buildRunData([null, {}, '000000', new Float64Array(run), [0, 0]]), []);
});

it('stops before reading another width when the visitor returns false', () => {
	let run = [0, 0, 0, 0, 3, 1, 1, 1];
	Object.defineProperty(run, 7, { get() { throw new Error('Decoded past rejection'); } });
	let visited = [];
	assert.equal(visitCharPositions(run, (start, end) => { visited.push([start, end]); return false; }), false);
	assert.deepEqual(visited, [[0, 1]]);
	assert.equal(visitCharPositions([0, 0, 0, 0, 1, 1], () => false), false);
});

it('omits trailing soft-hyphen widths without reading them', () => {
	let run = [1, 0, 0, 0, 3, 1, 1, 1];
	Object.defineProperty(run, 7, { get() { throw new Error('Decoded an omitted soft hyphen'); } });
	let visited = [];
	assert.equal(visitCharPositions(run, (start, end) => { visited.push([start, end]); }, true), true);
	assert.deepEqual(visited, [[0, 1]]);
	assert.equal(visitCharPositions([1, 0, 0, 0, 1, 1], () => { throw new Error('Visited a lone soft hyphen'); }, true), true);
});

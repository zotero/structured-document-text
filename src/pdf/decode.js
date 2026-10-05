import { HEADER_AXIS_DIR_SHIFT, HEADER_LAST_IS_SOFT_HYPHEN, isVertical } from './constants.js';

/**
 * Parse textMap JSON string into array of runs.
 */
export function parseTextMap(textMap) {
	if (typeof textMap !== 'string') {
		return [];
	}
	try {
		const parsed = JSON.parse(textMap);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// Internal primitive: callers validate runs and decide which positions to keep.
// Returning false from visit stops decoding immediately; values remain unfiltered.
// Optional context lets consumers reuse callbacks across runs.
export function visitCharPositions(run, visit, dropSoftHyphen = false, context) {
	const vertical = isVertical((run[0] >> HEADER_AXIS_DIR_SHIFT) & 3);
	const count = Math.max(1, run.length - 6) - (dropSoftHyphen ? run[0] & HEADER_LAST_IS_SOFT_HYPHEN : 0);
	let pos = run[vertical ? 3 : 2];
	if (!count) return true;
	if (run.length <= 6) return visit(pos, run[vertical ? 5 : 4], context) !== false;
	for (let i = 6; i < count + 6; i++) {
		let width = run[i];
		if (Array.isArray(width)) { pos += width[0]; width = width[1]; }
		const end = pos + width;
		if (visit(pos, end, context) === false) return false;
		pos = end;
	}
	return true;
}

/**
 * Reconstructs character positions from a run array, including soft hyphens.
 * Single-char runs have no widths; position is bbox.
 */
export function reconstructCharPositions(run) {
	if (!run || run.length < 6) return [];
	// Preserve the existing iterable inputs, including typed arrays.
	if (!Array.isArray(run)) run = [...run];
	const positions = [];
	visitCharPositions(run, appendPosition, false, positions);
	return positions;
}

function appendPosition(x1, x2, positions) {
	positions.push({ x1, x2 });
}

/**
 * Build run data with rects and page indexes from parsed runs.
 */
export function buildRunData(runs) {
	const state = { data: [], run: null, vertical: false };
	for (const run of runs) {
		if (!Array.isArray(run) || run.length < 6) {
			continue;
		}
		state.run = run;
		state.vertical = isVertical((run[0] >> HEADER_AXIS_DIR_SHIFT) & 3);
		visitCharPositions(run, appendRunData, true, state);
	}
	return state.data;
}

function appendRunData(start, end, { data, run, vertical }) {
	if (!Number.isFinite(start) || !Number.isFinite(end)) return;
	const rect = vertical
		? [run[2], start, run[4], end]
		: [start, run[3], end, run[5]];
	data.push({ rect, pageIndex: run[1], vertical });
}

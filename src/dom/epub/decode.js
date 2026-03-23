/**
 * EPUB selectorMap decode utilities.
 *
 * SelectorMaps are stored relative to their parent block's CFI path.
 * Single-entry: a CFI path suffix starting with '/'.
 * Multi-entry (merged text nodes): newline-separated "charLen suffix" entries,
 * starting with a digit.
 *
 * Use expandSelectorMap() to reconstruct absolute paths from the block anchor.
 * Character offsets are appended as `:offset` per the EPUB CFI spec.
 * Ranges use CFI range syntax: `epubcfi(common_path,local_start,local_end)`.
 */

const CONFORMSTO = 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html';

/**
 * Expand a relative text node selectorMap to absolute paths using the block's selectorMap.
 *
 * @param {string} blockSelectorMap - the block's absolute CFI path
 * @param {string} selectorMap - relative selectorMap (suffix or multi-entry)
 * @returns {string} absolute selectorMap
 */
export function expandSelectorMap(blockSelectorMap, selectorMap) {
	let entries = parseSelectorMapEntries(selectorMap);
	if (entries) {
		return entries.map(e => e.length + ' ' + blockSelectorMap + e.path).join('\n');
	}
	return blockSelectorMap + selectorMap;
}

/**
 * Expand a block's selectorMap to a full WADM FragmentSelector.
 *
 * @param {string} blockSelectorMap - the block's absolute CFI path
 * @returns {{ type: string, conformsTo: string, value: string }}
 */
export function expandBlockAnchor(blockSelectorMap) {
	return {
		type: 'FragmentSelector',
		conformsTo: CONFORMSTO,
		value: `epubcfi(${blockSelectorMap})`,
	};
}

/**
 * Parse a selectorMap into entries. Returns null for single-entry selectorMaps.
 *
 * @param {string} selectorMap
 * @returns {{ length: number, path: string }[] | null}
 */
export function parseSelectorMapEntries(selectorMap) {
	if (selectorMap.startsWith('/')) return null;
	return selectorMap.split('\n').map(line => {
		let sp = line.indexOf(' ');
		return {
			length: parseInt(line.substring(0, sp)),
			path: line.substring(sp + 1),
		};
	});
}

/**
 * Find which entry contains a character offset (0-based).
 * Returns the entry's CFI path and the local offset within that entry.
 */
function findEntryAt(entries, offset) {
	let cumulative = 0;
	for (let i = 0; i < entries.length; i++) {
		if (offset < cumulative + entries[i].length) {
			return { path: entries[i].path, local: offset - cumulative };
		}
		cumulative += entries[i].length;
	}
	let last = entries[entries.length - 1];
	return { path: last.path, local: last.length };
}

/**
 * Resolve a character range to a CFI range.
 * Handles both single-entry and multi-entry (merged) selectorMaps.
 *
 * @param {string} selectorMap - absolute CFI path or multi-entry selectorMap
 * @param {number} start - start character index (inclusive)
 * @param {number} end - end character index (exclusive)
 * @returns {{ type: string, conformsTo: string, value: string }}
 */
export function resolveSelectorMap(selectorMap, start, end) {
	let entries = parseSelectorMapEntries(selectorMap);
	if (entries) {
		return resolveMultiEntry(entries, start, end !== undefined ? end : start + 1);
	}

	if (end === undefined || end === start + 1) {
		return {
			type: 'FragmentSelector',
			conformsTo: CONFORMSTO,
			value: `epubcfi(${selectorMap}:${start})`,
		};
	}
	return {
		type: 'FragmentSelector',
		conformsTo: CONFORMSTO,
		value: `epubcfi(${selectorMap},:${start},:${end})`,
	};
}

function resolveMultiEntry(entries, start, end) {
	let s = findEntryAt(entries, start);
	let e = findEntryAt(entries, end - 1);
	let endLocal = e.local + 1;

	if (s.path === e.path) {
		if (endLocal === s.local + 1) {
			return {
				type: 'FragmentSelector',
				conformsTo: CONFORMSTO,
				value: `epubcfi(${s.path}:${s.local})`,
			};
		}
		return {
			type: 'FragmentSelector',
			conformsTo: CONFORMSTO,
			value: `epubcfi(${s.path},:${s.local},:${endLocal})`,
		};
	}

	return resolveSelectorMapRange(s.path, s.local, e.path, endLocal);
}

/**
 * Find the longest common CFI path prefix between two paths.
 */
export function findCommonCFIPath(a, b) {
	if (a === b) {
		return { common: a, remainderA: '', remainderB: '' };
	}

	let stepsA = a.match(/\/[^/]*/g) || [];
	let stepsB = b.match(/\/[^/]*/g) || [];

	let commonLen = 0;
	let min = Math.min(stepsA.length, stepsB.length);
	for (let i = 0; i < min; i++) {
		if (stepsA[i] !== stepsB[i]) break;
		commonLen = i + 1;
	}

	let common = stepsA.slice(0, commonLen).join('');
	let remainderA = stepsA.slice(commonLen).join('');
	let remainderB = stepsB.slice(commonLen).join('');

	return { common, remainderA, remainderB };
}

/**
 * Resolve a cross-node character range to a CFI range.
 *
 * @param {string} startPath - absolute CFI path for start text node
 * @param {number} startOffset - character offset in start node
 * @param {string} endPath - absolute CFI path for end text node
 * @param {number} endOffset - character offset in end node
 */
export function resolveSelectorMapRange(startPath, startOffset, endPath, endOffset) {
	if (startPath === endPath) {
		return resolveSelectorMap(startPath, startOffset, endOffset);
	}

	let { common, remainderA, remainderB } = findCommonCFIPath(startPath, endPath);

	return {
		type: 'FragmentSelector',
		conformsTo: CONFORMSTO,
		value: `epubcfi(${common},${remainderA}:${startOffset},${remainderB}:${endOffset})`,
	};
}

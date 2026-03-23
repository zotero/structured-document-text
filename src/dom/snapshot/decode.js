import { nfcToOriginal, nfcToOriginalLocal } from '../deltamap.js';

/**
 * Snapshot selectorMap decode utilities.
 *
 * SelectorMaps are stored relative to their parent block's CSS selector.
 * Formats:
 *   "" (empty)        — same element as block (sole-child text)
 *   "25"              — same element, text at offset 25 (mixed-content)
 *   " > strong"       — child element suffix (sole-child text)
 *   " > strong 0"     — child element suffix with offset (mixed-content)
 *   "p:nth-child(3)"  — absolute fallback (inline element has its own id)
 *   digit-prefixed    — multi-entry (merged text nodes)
 *
 * Use expandSelectorMap() to reconstruct absolute selectors from the block anchor.
 */

/**
 * Expand a relative text node selectorMap to an absolute selector using the block's selectorMap.
 *
 * @param {string} blockSelectorMap - the block's absolute CSS selector
 * @param {string} selectorMap - relative selectorMap
 * @returns {string} absolute selectorMap (suitable for parseSelectorMap/resolveSelectorMap)
 */
export function expandSelectorMap(blockSelectorMap, selectorMap) {
	if (selectorMap === '') return blockSelectorMap;
	if (selectorMap.startsWith(' > ')) return blockSelectorMap + selectorMap;
	if (/^\d+$/.test(selectorMap)) return blockSelectorMap + ' ' + selectorMap;
	if (selectorMap.includes('\n')) {
		return selectorMap.split('\n').map(line => {
			let sp = line.indexOf(' ');
			let len = line.substring(0, sp);
			let sm = line.substring(sp + 1);
			return len + ' ' + expandSelectorMap(blockSelectorMap, sm);
		}).join('\n');
	}
	return selectorMap;
}

/**
 * Expand a block's selectorMap to a full WADM CssSelector.
 *
 * @param {string} blockSelectorMap - the block's absolute CSS selector
 * @returns {{ type: string, value: string }}
 */
export function expandBlockAnchor(blockSelectorMap) {
	return { type: 'CssSelector', value: blockSelectorMap };
}

/**
 * Parse a single-entry absolute selectorMap into its components.
 *
 * @param {string} selectorMap - CSS selector, optionally with ' <offset>' suffix
 * @returns {{ selector: string, offset: number }}
 */
export function parseSelectorMap(selectorMap) {
	let lastSpace = selectorMap.lastIndexOf(' ');
	if (lastSpace > 0) {
		let suffix = selectorMap.substring(lastSpace + 1);
		let parsed = parseInt(suffix, 10);
		if (parsed >= 0 && String(parsed) === suffix) {
			return {
				selector: selectorMap.substring(0, lastSpace),
				offset: parsed,
			};
		}
	}
	return { selector: selectorMap, offset: 0 };
}

/**
 * Parse a selectorMap into multi-entry format. Returns null for single-entry.
 *
 * @param {string} selectorMap
 * @returns {{ length: number, selectorMap: string }[] | null}
 */
export function parseSelectorMapEntries(selectorMap) {
	if (!/^\d/.test(selectorMap)) return null;
	return selectorMap.split('\n').map(line => {
		let sp = line.indexOf(' ');
		return {
			length: parseInt(line.substring(0, sp)),
			selectorMap: line.substring(sp + 1),
		};
	});
}

/**
 * Resolve a character range to a WADM CssSelector with TextPositionSelector.
 * Handles both single-entry and multi-entry (merged) selectorMaps.
 *
 * @param {string} selectorMap - absolute CSS selector (optionally with offset), or multi-entry
 * @param {number} start - start character index (inclusive, relative to text node, in NFC space)
 * @param {number} end - end character index (exclusive, relative to text node, in NFC space)
 * @param {string} [deltaMap] - optional NFC deltaMap for position translation
 * @returns {{ type: string, value: string, refinedBy: { type: string, start: number, end: number } }}
 */
export function resolveSelectorMap(selectorMap, start, end, deltaMap) {
	let entries = parseSelectorMapEntries(selectorMap);
	if (entries) {
		let cumulative = 0;
		for (let entry of entries) {
			if (start < cumulative + entry.length) {
				let localStart = start - cumulative;
				let localEnd = (end !== undefined ? end : start + 1) - cumulative;
				localEnd = Math.min(localEnd, entry.length);
				// Translate local NFC offsets to original offsets
				let origLocalStart = nfcToOriginalLocal(deltaMap, cumulative, localStart);
				let origLocalEnd = nfcToOriginalLocal(deltaMap, cumulative, localEnd);
				return resolveSingleEntry(entry.selectorMap, origLocalStart, origLocalEnd);
			}
			cumulative += entry.length;
		}
		let last = entries[entries.length - 1];
		let origLen = nfcToOriginalLocal(deltaMap, cumulative - last.length, last.length);
		return resolveSingleEntry(last.selectorMap, origLen, origLen);
	}

	let origStart = nfcToOriginal(deltaMap, start);
	let origEnd = nfcToOriginal(deltaMap, end !== undefined ? end : start + 1);
	let { selector, offset } = parseSelectorMap(selectorMap);
	return {
		type: 'CssSelector',
		value: selector,
		refinedBy: {
			type: 'TextPositionSelector',
			start: offset + origStart,
			end: offset + origEnd,
		},
	};
}

/**
 * Resolve a single-entry selectorMap (already in original/DOM space).
 */
function resolveSingleEntry(selectorMap, origStart, origEnd) {
	let { selector, offset } = parseSelectorMap(selectorMap);
	return {
		type: 'CssSelector',
		value: selector,
		refinedBy: {
			type: 'TextPositionSelector',
			start: offset + origStart,
			end: offset + origEnd,
		},
	};
}

/**
 * Shared text node and block utilities for structured text.
 */

import { deepEqual } from './utils.js';

function canMerge(a, b) {
	let aAnc = a.anchor ?? null;
	let bAnc = b.anchor ?? null;
	if (aAnc !== bAnc && !deepEqual(aAnc, bAnc)) return false;

	return (
		deepEqual(a.style ?? null, b.style ?? null) &&
		deepEqual(a.refs ?? null, b.refs ?? null) &&
		deepEqual(a.backRefs ?? null, b.backRefs ?? null) &&
		deepEqual(a.target ?? null, b.target ?? null)
	);
}

/**
 * Merge adjacent text nodes that share the same anchor, style, refs, and target.
 * Preserves object identity for unmerged nodes (copy-on-write).
 */
export function mergeTextNodes(textNodes) {
	if (textNodes.length === 0) return textNodes;

	let merged = [];
	let current = null;
	let copied = false;

	for (let node of textNodes) {
		if (!current) {
			current = node;
			copied = false;
			continue;
		}

		if (!canMerge(current, node)) {
			merged.push(current);
			current = node;
			copied = false;
			continue;
		}

		if (!copied) {
			current = { ...current };
			copied = true;
		}
		current.text += node.text;
	}

	if (current) merged.push(current);
	return merged;
}

/**
 * Check if an anchor is a DomAnchor (only has `selectorMap` string property).
 */
function isDomAnchor(anchor) {
	if (!anchor || typeof anchor !== 'object') return false;
	let keys = Object.keys(anchor);
	return keys.length === 1 && keys[0] === 'selectorMap' && typeof anchor.selectorMap === 'string';
}

/**
 * Convert a single-entry selectorMap to entry format: "charLen selectorMap".
 * Multi-entry selectorMaps (starting with a digit) are returned as-is.
 */
function toEntries(selectorMap, textLen) {
	if (/^\d/.test(selectorMap)) return selectorMap;
	return textLen + ' ' + selectorMap;
}

/**
 * Merge adjacent text nodes with DomAnchors that share the same
 * style, refs, backRefs, and target — combining their selectorMaps into
 * a multi-entry format. This is the DOM equivalent of
 * pdf/text-node.js:mergeSequentialTextNodes.
 *
 * Must be called AFTER cross-reference resolution (refs/backRefs/targets
 * are finalized), not during initial extraction.
 *
 * Mutates content in-place.
 */
export function mergeNodesWithSelectorMap(content) {
	if (!Array.isArray(content) || content.length === 0) {
		return content;
	}

	let merged = [];
	let current = null;
	let copied = false;

	function finalize() {
		if (current) merged.push(current);
		current = null;
		copied = false;
	}

	for (let node of content) {
		let isTextNode = node && typeof node.text === 'string';

		if (!isTextNode) {
			finalize();
			merged.push(node);
			continue;
		}

		if (!current) {
			current = node;
			copied = false;
			continue;
		}

		// Only merge if both have DomAnchors and style/refs/target match
		if (!isDomAnchor(current.anchor) || !isDomAnchor(node.anchor)
			|| !deepEqual(current.style ?? null, node.style ?? null)
			|| !deepEqual(current.refs ?? null, node.refs ?? null)
			|| !deepEqual(current.backRefs ?? null, node.backRefs ?? null)
			|| !deepEqual(current.target ?? null, node.target ?? null)) {
			finalize();
			current = node;
			copied = false;
			continue;
		}

		if (!copied) {
			current = { ...current };
			copied = true;
		}

		// Combine selectorMaps: "len1 path1\nlen2 path2"
		if (current.anchor.selectorMap !== node.anchor.selectorMap) {
			current.anchor = {
				selectorMap: toEntries(current.anchor.selectorMap, current.text.length)
					+ '\n' + toEntries(node.anchor.selectorMap, node.text.length),
			};
		}

		current.text += node.text;
	}

	finalize();

	content.length = 0;
	content.push(...merged);
	return content;
}

/**
 * Get plain text from a leaf block (flat content).
 */
export function getBlockPlainText(block) {
	if (!block.content) return '';
	let text = '';
	for (let child of block.content) {
		if (child.text !== undefined) text += child.text;
	}
	return text;
}

/**
 * Get plain text from a block, recursing into nested blocks.
 */
export function getNestedBlockPlainText(node) {
	if (node.text !== undefined) return node.text;
	if (!node.content) return '';

	let hasChildBlock = node.content.some(child => child.text === undefined);

	if (!hasChildBlock) {
		let result = '';
		for (let child of node.content) {
			if (child.text !== undefined) result += child.text;
		}
		return result;
	}

	let parts = [];
	for (let child of node.content) {
		if (child.text !== undefined) continue;
		let text = getNestedBlockPlainText(child);
		if (text) parts.push(text);
	}
	return parts.join('\n');
}

/**
 * Get a content range (start/end ref paths) spanning block indexes.
 */
export function getContentRange(content, startOffset, endOffset) {
	function firstLeafPath(node, path) {
		let current = node;
		let currentPath = [...path];
		while (current.content && current.content.length > 0) {
			current = current.content[0];
			currentPath.push(0);
		}
		return currentPath;
	}

	function lastLeafPath(node, path) {
		let current = node;
		let currentPath = [...path];
		while (current.content && current.content.length > 0) {
			let lastIndex = current.content.length - 1;
			current = current.content[lastIndex];
			currentPath.push(lastIndex);
		}
		return currentPath;
	}

	let maxIndex = content.length - 1;
	let safeStart = Math.max(0, Math.min(startOffset, maxIndex));
	let safeEnd = Math.max(0, Math.min(endOffset, maxIndex));

	return {
		start: { ref: firstLeafPath(content[safeStart], [safeStart]) },
		end: { ref: lastLeafPath(content[safeEnd], [safeEnd]) },
	};
}

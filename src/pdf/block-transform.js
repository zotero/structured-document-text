/**
 * Block transformations: attribute application, reordering, and merging.
 */

import {
	HEADER_AXIS_DIR_SHIFT,
	HEADER_LAST_IS_SOFT_HYPHEN,
	EPS,
	isVertical,
} from './constants.js';
import { parseTextMap, reconstructCharPositions } from './decode.js';
import { canMergeTextNodes, mergeSequentialTextNodes } from './text-node.js';
import { getBlockByRef, getContentRangeFromBlocks } from './block.js';
import { isWhitespaceChar, sameRef } from './utils.js';

function mergePageRects(blocks) {
	const allRects = [];
	for (const block of blocks) {
		const rects = block?.anchor?.pageRects;
		if (Array.isArray(rects)) allRects.push(...rects);
	}
	return allRects.length > 0 ? allRects : null;
}

function sliceTextMap(textMap, text, startOffset, endOffset) {
	const runs = parseTextMap(textMap);
	if (!runs.length) {
		return null;
	}

	// `startOffset` and `endOffset` are offsets into `text` (counting whitespace),
	// while textMap runs encode one position per non-whitespace character. Convert
	// text offsets to non-whitespace position offsets before slicing so the slice
	// lines up with the right characters.
	let nwStart = 0, nwEnd = 0;
	for (let i = 0; i < endOffset; i++) {
		if (isWhitespaceChar(text[i])) continue;
		if (i < startOffset) nwStart++;
		nwEnd++;
	}
	startOffset = nwStart;
	endOffset = nwEnd;

	const newRuns = [];
	let charIndex = 0;

	for (const run of runs) {
		if (!Array.isArray(run) || run.length < 6) {
			continue;
		}

		const [header, pageIndex, minX, minY, maxX, maxY] = run;
		const allPositions = reconstructCharPositions(run);
		const hasSoftHyphen = !!(header & HEADER_LAST_IS_SOFT_HYPHEN);
		const charPositions = hasSoftHyphen ? allPositions.slice(0, -1) : allPositions;

		const runStart = charIndex;
		const runEnd = charIndex + charPositions.length;

		// Skip runs completely outside range
		if (runEnd <= startOffset || runStart >= endOffset) {
			charIndex = runEnd;
			continue;
		}

		// Calculate slice boundaries within this run
		const sliceStart = Math.max(0, startOffset - runStart);
		const sliceEnd = Math.min(charPositions.length, endOffset - runStart);
		const slicedPositions = charPositions.slice(sliceStart, sliceEnd);

		if (slicedPositions.length > 0) {
			const keepSoftHyphen = hasSoftHyphen && sliceEnd === charPositions.length;
			const newHeader = keepSoftHyphen
				? header
				: header & ~HEADER_LAST_IS_SOFT_HYPHEN;

			// Re-encode sliced positions as per-glyph widths
			const axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 0b11;
			const vertical = isVertical(axisDir);
			const newRun = [newHeader, pageIndex, minX, minY, maxX, maxY];
			const emit = keepSoftHyphen
				? [...slicedPositions, allPositions[allPositions.length - 1]]
				: slicedPositions;
			let pos = vertical ? minY : minX;
			for (const emitPos of emit) {
				if (!emitPos || !Number.isFinite(emitPos.x1) || !Number.isFinite(emitPos.x2)) continue;
				const delta = emitPos.x1 - pos;
				const width = emitPos.x2 - emitPos.x1;
				if (Math.abs(delta) > EPS) {
					newRun.push([delta, width]);
				}
				else {
					newRun.push(width);
				}
				pos = emitPos.x2;
			}

			newRuns.push(newRun);
		}

		charIndex = runEnd;
	}

	return newRuns.length ? JSON.stringify(newRuns) : null;
}

/**
 * Apply a callback to text nodes within a range, splitting nodes if necessary.
 */
export function applyTextAttributes(structure, blockRef, offsetStart, offsetEnd, callback) {
	const block = getBlockByRef(structure, blockRef);
	if (!block) {
		return null;
	}

	const startsWithRef = (ref, prefix) => {
		if (!Array.isArray(ref) || !Array.isArray(prefix) || prefix.length > ref.length) {
			return false;
		}
		for (let i = 0; i < prefix.length; i++) {
			if (ref[i] !== prefix[i]) {
				return false;
			}
		}
		return true;
	};

	const walkTextNodesWithRefs = (node, path, visitor) => {
		if (!node || typeof node !== 'object') {
			return true;
		}
		if (typeof node.text === 'string') {
			return visitor(node, path) !== false;
		}
		if (Array.isArray(node.content)) {
			for (let i = 0; i < node.content.length; i++) {
				const child = node.content[i];
				const shouldContinue = walkTextNodesWithRefs(child, [...path, i], visitor);
				if (!shouldContinue) {
					return false;
				}
			}
		}
		return true;
	};

	const getAbsoluteOffsetForRef = (root, rootRef, targetRef, targetOffset, isEnd) => {
		if (!Array.isArray(targetRef) || !startsWithRef(targetRef, rootRef)) {
			return null;
		}
		const localRef = targetRef.slice(rootRef.length);
		let absolute = null;
		let currentOffset = 0;
		let firstMatch = null;
		let lastMatch = null;

		const clampOffset = (offset, length, endBias) => {
			if (!Number.isInteger(offset)) {
				return endBias ? Math.max(0, length - 1) : 0;
			}
			if (length <= 0) {
				return 0;
			}
			return Math.max(0, Math.min(offset, length - 1));
		};

		walkTextNodesWithRefs(root, [], (node, path) => {
			const len = node.text.length;
			const isExact = localRef.length > 0 && sameRef(path, localRef);
			const isMatch = isExact || localRef.length === 0 || startsWithRef(path, localRef);
			if (isMatch) {
				const offset = clampOffset(targetOffset, len, isEnd);
				const abs = currentOffset + offset;
				if (isExact) {
					absolute = abs;
					return false;
				}
				if (firstMatch === null) {
					firstMatch = abs;
				}
				lastMatch = abs;
			}
			currentOffset += len;
			return true;
		});

		if (absolute !== null) {
			return absolute;
		}
		return isEnd ? lastMatch : firstMatch;
	};

	const getRefForAbsoluteOffset = (root, rootRef, absOffset) => {
		if (!Number.isInteger(absOffset)) {
			return null;
		}
		let currentOffset = 0;
		let found = null;
		let lastRef = null;
		let lastLen = 0;

		walkTextNodesWithRefs(root, [], (node, path) => {
			const len = node.text.length;
			lastRef = [...rootRef, ...path];
			lastLen = len;

			if (len > 0) {
				if (absOffset <= currentOffset + len - 1) {
					found = {
						ref: [...rootRef, ...path],
						offset: absOffset - currentOffset
					};
					return false;
				}
				currentOffset += len;
			}
			return true;
		});

		if (found) {
			return found;
		}

		if (!lastRef) {
			return null;
		}

		const clamped = lastLen > 0 ? Math.max(0, Math.min(absOffset - (currentOffset - lastLen), lastLen - 1)) : 0;
		return { ref: lastRef, offset: clamped };
	};

	const rangeUpdates = [];
	if (Array.isArray(structure?.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}
			for (const range of page.contentRanges) {
				if (range?.start?.ref && startsWithRef(range.start.ref, blockRef)) {
					const absOffset = getAbsoluteOffsetForRef(block, blockRef, range.start.ref, range.start.offset, false);
					if (absOffset !== null) {
						rangeUpdates.push({
							target: range.start,
							absOffset,
							hasOffset: Number.isInteger(range.start.offset)
						});
					}
				}
				if (range?.end?.ref && startsWithRef(range.end.ref, blockRef)) {
					const absOffset = getAbsoluteOffsetForRef(block, blockRef, range.end.ref, range.end.offset, true);
					if (absOffset !== null) {
						rangeUpdates.push({
							target: range.end,
							absOffset,
							hasOffset: Number.isInteger(range.end.offset)
						});
					}
				}
			}
		}
	}

	// Treat offsetEnd as inclusive; normalize to a sane range.
	if (!Number.isInteger(offsetStart) || !Number.isInteger(offsetEnd)) {
		return null;
	}
	if (offsetEnd < offsetStart) {
		[offsetStart, offsetEnd] = [offsetEnd, offsetStart];
	}

	let currentOffset = 0;
	let targetTextNodeRef = null;
	let didSplit = false;

	const processNode = (node, parentRef) => {
		if (!node || typeof node !== 'object') {
			return node;
		}

		// If it's a text node
		if (typeof node.text === 'string') {
			const text = node.text;
			const nodeStart = currentOffset;
			const nodeEnd = currentOffset + text.length;
			currentOffset = nodeEnd;

			// No overlap (inclusive end)
			if (nodeEnd - 1 < offsetStart || nodeStart > offsetEnd) {
				return node;
			}

			// Complete overlap - apply callback to entire node
			if (nodeStart >= offsetStart && nodeEnd - 1 <= offsetEnd) {
				const result = callback(node);
				if (!targetTextNodeRef) {
					targetTextNodeRef = parentRef;
				}
				return result;
			}

			// Partial overlap - need to split
			const result = [];
			didSplit = true;
			const hasAnchor = node.anchor?.textMap;

			// Before range
			if (nodeStart < offsetStart) {
				const beforeText = text.substring(0, offsetStart - nodeStart);
				const beforeNode = {
					...node,
					text: beforeText,
				};

				if (hasAnchor && node.anchor) {
					const slicedMap = sliceTextMap(node.anchor.textMap, text, 0, offsetStart - nodeStart);
					if (slicedMap) {
						beforeNode.anchor = { ...node.anchor, textMap: slicedMap };
					} else {
						delete beforeNode.anchor;
					}
				}

				result.push(beforeNode);
			}

			// Inside range - apply callback (offsetEnd inclusive => end is +1)
			const rangeStart = Math.max(0, offsetStart - nodeStart);
			const rangeEnd = Math.min(text.length, offsetEnd - nodeStart + 1);
			const rangeText = text.substring(rangeStart, rangeEnd);
			const rangeNode = {
				...node,
				text: rangeText,
			};

			if (hasAnchor && node.anchor) {
				const slicedMap = sliceTextMap(node.anchor.textMap, text, rangeStart, rangeEnd);
				if (slicedMap) {
					rangeNode.anchor = { ...node.anchor, textMap: slicedMap };
				} else {
					delete rangeNode.anchor;
				}
			}

			const callbackResult = callback(rangeNode);
			if (!targetTextNodeRef) {
				const indexInResult = nodeStart < offsetStart ? 1 : 0;
				const parentPath = parentRef.slice(0, -1);
				const parentIndex = parentRef[parentRef.length - 1];
				targetTextNodeRef = [...parentPath, parentIndex + indexInResult];
			}
			result.push(callbackResult);

			// After range
			if (nodeEnd - 1 > offsetEnd) {
				const afterText = text.substring(offsetEnd - nodeStart + 1);
				const afterNode = {
					...node,
					text: afterText,
				};

				if (hasAnchor && node.anchor) {
					const slicedMap = sliceTextMap(node.anchor.textMap, text, offsetEnd - nodeStart + 1, text.length);
					if (slicedMap) {
						afterNode.anchor = { ...node.anchor, textMap: slicedMap };
					} else {
						delete afterNode.anchor;
					}
				}

				result.push(afterNode);
			}

			return result;
		}

		// If it has content array, recurse
		if (Array.isArray(node.content)) {
			const newContent = [];
			for (let i = 0; i < node.content.length; i++) {
				const child = node.content[i];
				const childRef = [...parentRef, newContent.length];
				const processed = processNode(child, childRef);
				if (Array.isArray(processed)) {
					newContent.push(...processed);
				} else if (processed) {
					newContent.push(processed);
				}
			}
			return {
				...node,
				content: newContent,
			};
		}

		return node;
	};

	// Persist processed changes back into the referenced block
	const updatedBlock = processNode(block, blockRef);

	if (Array.isArray(updatedBlock)) {
		// Unexpected, but handle defensively by replacing block content
		block.content = updatedBlock;
		return targetTextNodeRef;
	}

	if (updatedBlock && updatedBlock !== block) {
		Object.assign(block, updatedBlock);
	}

	if (didSplit && rangeUpdates.length > 0) {
		for (const update of rangeUpdates) {
			const mapped = getRefForAbsoluteOffset(block, blockRef, update.absOffset);
			if (!mapped) {
				continue;
			}
			update.target.ref = mapped.ref;
			if (update.hasOffset) {
				update.target.offset = mapped.offset;
			}
		}
	}

	return targetTextNodeRef;
}

/**
 * Move artifact blocks to end of content, updating refs.
 */
export function pushArtifactsToTheEnd(structure) {
	if (!structure) {
		return structure;
	}

	const blocks = structure.content;

	if (!Array.isArray(blocks) || blocks.length === 0) {
		return structure;
	}

	const nonArtifacts = [];
	const artifacts = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block && block.artifact) {
			artifacts.push({ block, index: i });
		} else {
			nonArtifacts.push({ block, index: i });
		}
	}

	if (artifacts.length === 0) {
		return structure;
	}

	const indexMap = new Map();
	let nextIndex = 0;
	const reordered = [];

	for (const item of nonArtifacts) {
		indexMap.set(item.index, nextIndex++);
		reordered.push(item.block);
	}

	for (const item of artifacts) {
		indexMap.set(item.index, nextIndex++);
		reordered.push(item.block);
	}

	blocks.length = 0;
	blocks.push(...reordered);

	const updateRefPath = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return;
		}
		const mapped = indexMap.get(ref[0]);
		if (typeof mapped === 'number') {
			ref[0] = mapped;
		}
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);
		updateRefsArray(node.backRefs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				updateNodeRefs(child);
			}
		}
	};

	for (const block of blocks) {
		updateNodeRefs(block);
	}

	const copyRef = (ref) => (Array.isArray(ref) ? [...ref] : null);

	if (structure && Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}

			const updatedRanges = [];

			for (const range of page.contentRanges) {
				const startRef = range && range.start ? range.start.ref : null;
				const endRef = range && range.end ? range.end.ref : null;
				const startIndex = Array.isArray(startRef) ? startRef[0] : null;
				const endIndex = Array.isArray(endRef) ? endRef[0] : null;

				if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex > endIndex) {
					if (range && range.start) {
						updateRefPath(range.start.ref);
					}
					if (range && range.end) {
						updateRefPath(range.end.ref);
					}
					updatedRanges.push(range);
					continue;
				}

				const expanded = [];
				for (let i = startIndex; i <= endIndex; i++) {
					expanded.push({
						oldIndex: i,
						startRef: i === startIndex ? startRef : null,
						endRef: i === endIndex ? endRef : null
					});
				}

				let runStart = 0;
				for (let i = 1; i <= expanded.length; i++) {
					const prev = expanded[i - 1];
					const prevNewIndex = indexMap.get(prev.oldIndex);
					const curr = expanded[i];
					const currNewIndex = curr ? indexMap.get(curr.oldIndex) : null;
					const isConsecutive = curr && prevNewIndex + 1 === currNewIndex;

					if (!curr || !isConsecutive) {
						const first = expanded[runStart];
						const last = expanded[i - 1];
						const startNewIndex = indexMap.get(first.oldIndex);
						const endNewIndex = indexMap.get(last.oldIndex);
						const autoRange = getContentRangeFromBlocks(blocks, startNewIndex, endNewIndex);

						let rangeStartRef = first.startRef ? copyRef(first.startRef) : autoRange.start.ref;
						let rangeEndRef = last.endRef ? copyRef(last.endRef) : autoRange.end.ref;

						if (Array.isArray(rangeStartRef) && Number.isInteger(startNewIndex)) {
							rangeStartRef[0] = startNewIndex;
						}
						if (Array.isArray(rangeEndRef) && Number.isInteger(endNewIndex)) {
							rangeEndRef[0] = endNewIndex;
						}

						updatedRanges.push({
							start: {
								ref: rangeStartRef
							},
							end: {
								ref: rangeEndRef
							}
						});

						runStart = i;
					}
				}
			}

			page.contentRanges = updatedRanges;
		}
	}

	return structure;
}

/**
 * Merge multiple blocks into one, updating refs.
 */
export function mergeBlocks(structure, blockIndexes) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	if (!Array.isArray(blockIndexes) || blockIndexes.length === 0) {
		return structure;
	}

	const originalContent = structure.content;
	const maxIndex = originalContent.length - 1;

	const groups = [];
	const used = new Set();

	for (const group of blockIndexes) {
		if (!Array.isArray(group)) {
			continue;
		}

		const unique = [];
		const seen = new Set();
		for (const index of group) {
			if (!Number.isInteger(index) || index < 0 || index > maxIndex || seen.has(index)) {
				continue;
			}
			seen.add(index);
			unique.push(index);
		}

		unique.sort((a, b) => a - b);

		const cleaned = [];
		for (const index of unique) {
			if (used.has(index)) {
				continue;
			}
			cleaned.push(index);
		}

		if (cleaned.length < 2) {
			continue;
		}

		for (const index of cleaned) {
			used.add(index);
		}

		groups.push({ indexes: cleaned, start: cleaned[0] });
	}

	if (groups.length === 0) {
		return structure;
	}

	groups.sort((a, b) => b.start - a.start);

	const indexToGroup = new Map();
	for (const group of groups) {
		for (const index of group.indexes) {
			indexToGroup.set(index, group);
		}
	}

	const newContent = [];
	const indexMap = new Map();
	const childIndexMaps = new Map();
	const childTextOffsetMaps = new Map();
	const mergedTextNodeCounts = new Map();

	const ensureChildMap = (blockIndex) => {
		let map = childIndexMaps.get(blockIndex);
		if (!map) {
			map = [];
			childIndexMaps.set(blockIndex, map);
		}
		return map;
	};

	const ensureChildOffsetMap = (blockIndex) => {
		let map = childTextOffsetMaps.get(blockIndex);
		if (!map) {
			map = [];
			childTextOffsetMaps.set(blockIndex, map);
		}
		return map;
	};

	const getTextNodeLength = (node) => {
		if (!node || typeof node.text !== 'string') {
			return null;
		}
		return node.text.length;
	};

	const mergeGroup = (group) => {
		const mergedIndex = newContent.length;
		const baseBlock = originalContent[group.start];
		const mergedContent = [];
		const contentMeta = [];

		for (const blockIndex of group.indexes) {
			const block = originalContent[blockIndex];
			const blockContent = Array.isArray(block?.content) ? block.content : [];

			for (let i = 0; i < blockContent.length; i++) {
				mergedContent.push(blockContent[i]);
				contentMeta.push({ blockIndex, childIndex: i });
			}
		}

		let currentTextNode = null;
		let currentMergedIndex = -1;
		let nextMergedIndex = 0;
		let currentTextOffset = 0;

		for (let i = 0; i < mergedContent.length; i++) {
			const node = mergedContent[i];
			const meta = contentMeta[i];
			const isTextNode = node && typeof node.text === 'string';

			if (!isTextNode) {
				currentTextNode = null;
				currentMergedIndex = nextMergedIndex++;
				currentTextOffset = 0;
			} else if (!currentTextNode || !canMergeTextNodes(currentTextNode, node)) {
				currentTextNode = node;
				currentMergedIndex = nextMergedIndex++;
				currentTextOffset = 0;
			}

			const map = ensureChildMap(meta.blockIndex);
			map[meta.childIndex] = currentMergedIndex;

			if (isTextNode) {
				const length = getTextNodeLength(node);
				const offsetMap = ensureChildOffsetMap(meta.blockIndex);
				if (length != null) {
					offsetMap[meta.childIndex] = { offsetStart: currentTextOffset, length };
					currentTextOffset += length;
				}

				const mergedCount = mergedTextNodeCounts.get(currentMergedIndex) ?? 0;
				mergedTextNodeCounts.set(currentMergedIndex, mergedCount + 1);
			}
		}

		mergeSequentialTextNodes(mergedContent);

		const mergedBlock = baseBlock
			? { ...baseBlock, content: mergedContent }
			: { content: mergedContent };

		const blocksInGroup = group.indexes.map(idx => originalContent[idx]);
		const combinedRects = mergePageRects(blocksInGroup);
		if (combinedRects) {
			mergedBlock.anchor = { ...mergedBlock.anchor, pageRects: combinedRects };
		}

		for (const blockIndex of group.indexes) {
			indexMap.set(blockIndex, mergedIndex);
		}

		newContent.push(mergedBlock);
	};

	for (let i = 0; i < originalContent.length; i++) {
		const group = indexToGroup.get(i);

		if (group) {
			if (group.start !== i) {
				continue;
			}
			mergeGroup(group);
			continue;
		}

		const newIndex = newContent.length;
		newContent.push(originalContent[i]);
		indexMap.set(i, newIndex);
	}

	const isLeaf = (node) => !node || !node.content || node.content.length === 0;

	const firstLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			current = current.content[0];
			currentPath.push(0);
		}
		return current ? currentPath : null;
	};

	const lastLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			const children = current.content;
			const lastIndex = children.length - 1;
			current = children[lastIndex];
			currentPath.push(lastIndex);
		}
		return current ? currentPath : null;
	};

	const getBlockLeafPath = (block, useFirst) => {
		const content = block && Array.isArray(block.content) ? block.content : null;
		if (!content || content.length === 0) {
			return null;
		}

		const startIndex = useFirst ? 0 : content.length - 1;
		return useFirst
			? firstLeafPath(content[startIndex], [startIndex])
			: lastLeafPath(content[startIndex], [startIndex]);
	};

	const mapChildPath = (blockIndex, childPath) => {
		if (!Array.isArray(childPath) || childPath.length === 0) {
			return null;
		}
		const childMap = childIndexMaps.get(blockIndex);
		const mappedFirst = childMap ? childMap[childPath[0]] : childPath[0];
		if (!Number.isInteger(mappedFirst)) {
			return null;
		}
		return [mappedFirst, ...childPath.slice(1)];
	};

	const blockRangeMap = new Map();

	for (let i = 0; i < originalContent.length; i++) {
		const newIndex = indexMap.get(i);
		if (!Number.isInteger(newIndex)) {
			continue;
		}
		const block = originalContent[i];
		const startChild = getBlockLeafPath(block, true);
		const endChild = getBlockLeafPath(block, false);
		const mappedStartChild = mapChildPath(i, startChild);
		const mappedEndChild = mapChildPath(i, endChild);
		const startRef = mappedStartChild ? [newIndex, ...mappedStartChild] : null;
		const endRef = mappedEndChild ? [newIndex, ...mappedEndChild] : null;
		const oldStartRef = startChild ? [i, ...startChild] : null;
		const oldEndRef = endChild ? [i, ...endChild] : null;
		blockRangeMap.set(i, { startRef, endRef, oldStartRef, oldEndRef });
	}

	const mapRefPath = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return ref;
		}

		const oldIndex = ref[0];
		const newIndex = indexMap.get(oldIndex);
		if (!Number.isInteger(newIndex)) {
			return ref;
		}

		const mapped = [newIndex];
		if (ref.length > 1) {
			const childMap = childIndexMaps.get(oldIndex);
			const mappedChild = childMap ? childMap[ref[1]] : ref[1];
			if (Number.isInteger(mappedChild)) {
				mapped.push(mappedChild, ...ref.slice(2));
			} else {
				mapped.push(...ref.slice(1));
			}
		}
		return mapped;
	};

	const updateRefPath = (ref) => {
		const mapped = mapRefPath(ref);
		if (!Array.isArray(ref) || !Array.isArray(mapped)) {
			return;
		}
		ref.length = 0;
		ref.push(...mapped);
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);
		updateRefsArray(node.backRefs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				updateNodeRefs(child);
			}
		}
	};

	const getMergedTextNodeCount = (ref) => {
		if (!Array.isArray(ref) || ref.length < 2) {
			return 0;
		}
		const oldIndex = ref[0];
		const childIndex = ref[1];
		const childMap = childIndexMaps.get(oldIndex);
		const mergedIndex = childMap ? childMap[childIndex] : null;
		if (!Number.isInteger(mergedIndex)) {
			return 0;
		}
		return mergedTextNodeCounts.get(mergedIndex) ?? 0;
	};

	const getOffsetInfo = (ref) => {
		if (!Array.isArray(ref) || ref.length < 2) {
			return null;
		}
		const oldIndex = ref[0];
		const childIndex = ref[1];
		const offsetMap = childTextOffsetMaps.get(oldIndex);
		const entry = offsetMap ? offsetMap[childIndex] : null;
		if (!entry || !Number.isInteger(entry.offsetStart) || !Number.isInteger(entry.length)) {
			return null;
		}
		return entry;
	};

	const mapOffset = (ref, offset, isEnd) => {
		const hasOffset = Number.isInteger(offset);
		const needsOffset = hasOffset || getMergedTextNodeCount(ref) > 1;
		if (!needsOffset) {
			return null;
		}

		const info = getOffsetInfo(ref);
		if (info) {
			if (hasOffset) {
				return info.offsetStart + offset;
			}
			return info.offsetStart + (isEnd ? Math.max(0, info.length - 1) : 0);
		}

		return hasOffset ? offset : null;
	};

	structure.content = newContent;

	for (const block of structure.content) {
		updateNodeRefs(block);
	}

	if (Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}

			const updatedRanges = [];

			for (const range of page.contentRanges) {
				const startRef = range && range.start ? range.start.ref : null;
				const endRef = range && range.end ? range.end.ref : null;
				const startIndex = Array.isArray(startRef) ? startRef[0] : null;
				const endIndex = Array.isArray(endRef) ? endRef[0] : null;

				if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex > endIndex) {
					if (range && range.start) {
						const mappedOffset = mapOffset(range.start.ref, range.start.offset, false);
						updateRefPath(range.start.ref);
						if (Number.isInteger(mappedOffset)) {
							range.start.offset = mappedOffset;
						}
					}
					if (range && range.end) {
						const mappedOffset = mapOffset(range.end.ref, range.end.offset, true);
						updateRefPath(range.end.ref);
						if (Number.isInteger(mappedOffset)) {
							range.end.offset = mappedOffset;
						}
					}
					updatedRanges.push(range);
					continue;
				}

				const expanded = [];
				for (let i = startIndex; i <= endIndex; i++) {
					const segment = blockRangeMap.get(i);
					const mappedStart = i === startIndex ? mapRefPath(startRef) : segment?.startRef;
					const mappedEnd = i === endIndex ? mapRefPath(endRef) : segment?.endRef;
					const oldStartRef = i === startIndex ? startRef : segment?.oldStartRef;
					const oldEndRef = i === endIndex ? endRef : segment?.oldEndRef;

					expanded.push({
						oldIndex: i,
						startRef: mappedStart ?? segment?.startRef ?? null,
						endRef: mappedEnd ?? segment?.endRef ?? null,
						oldStartRef,
						oldEndRef
					});
				}

				let runStart = 0;
				for (let i = 1; i <= expanded.length; i++) {
					const prev = expanded[i - 1];
					const prevNewIndex = indexMap.get(prev.oldIndex);
					const curr = expanded[i];
					const currNewIndex = curr ? indexMap.get(curr.oldIndex) : null;
					const isConsecutive = curr && Number.isInteger(prevNewIndex) && Number.isInteger(currNewIndex)
						&& prevNewIndex + 1 === currNewIndex;

					if (!curr || !isConsecutive) {
						const first = expanded[runStart];
						const last = expanded[i - 1];
						const startNewIndex = indexMap.get(first.oldIndex);
						const endNewIndex = indexMap.get(last.oldIndex);

						const autoRange = (Number.isInteger(startNewIndex) && Number.isInteger(endNewIndex))
							? getContentRangeFromBlocks(structure.content, startNewIndex, endNewIndex)
							: { start: { ref: null }, end: { ref: null } };

						let rangeStartRef = first.startRef ? [...first.startRef] : autoRange.start.ref;
						let rangeEndRef = last.endRef ? [...last.endRef] : autoRange.end.ref;

						if (Array.isArray(rangeStartRef) && Number.isInteger(startNewIndex)) {
							rangeStartRef[0] = startNewIndex;
						}
						if (Array.isArray(rangeEndRef) && Number.isInteger(endNewIndex)) {
							rangeEndRef[0] = endNewIndex;
						}

						const startOffset = mapOffset(
							first.oldStartRef,
							first.oldIndex === startIndex ? range?.start?.offset : null,
							false
						);
						const endOffset = mapOffset(
							last.oldEndRef,
							last.oldIndex === endIndex ? range?.end?.offset : null,
							true
						);

						updatedRanges.push({
							start: {
								ref: rangeStartRef,
								...(Number.isInteger(startOffset) ? { offset: startOffset } : {})
							},
							end: {
								ref: rangeEndRef,
								...(Number.isInteger(endOffset) ? { offset: endOffset } : {})
							}
						});

						runStart = i;
					}
				}
			}

			page.contentRanges = updatedRanges;
		}
	}

	return structure;
}

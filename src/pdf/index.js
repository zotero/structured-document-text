// Constants
export {
	HEADER_LAST_IS_SOFT_HYPHEN,
	HEADER_AXIS_DIR_SHIFT,
	HEADER_DIR_RTL,
	EPS,
	isVertical,
} from './constants.js';

// Encoding (chars → text nodes)
export { charsToTextNodes, charsToPreformattedTextNodes } from './encode.js';

// Decoding (textMap → positions)
export { parseTextMap, reconstructCharPositions, buildRunData } from './decode.js';

// Text node utilities
export { canMergeTextNodes, mergeSequentialTextNodes, getBlockPlainText, getNestedBlockPlainText } from './text-node.js';

// Block reading (navigation, text, cursors)
export {
	getBlockByRef,
	getBlockText,
	getNextBlockRef,
	getTextNodesAtRange,
	getContentRangeFromBlocks,
	nextChar,
	nextBlockChar,
} from './block.js';

// Block transformations (mutations, reordering, merging)
export {
	applyTextAttributes,
	pushArtifactsToTheEnd,
	mergeBlocks,
} from './block-transform.js';

// Debug utilities
export { compareRunErrors, printOptimizationReport } from './debug.js';

// Content utilities
export { getRefRangesFromPageRects, getContent, getSentencePageRects } from './content.js';

// Generic utilities (work with any structured text)
export { getFulltextFromStructuredText } from './fulltext.js';
export { exportOutline } from './outline.js';
export { getNextChunk } from './chunker.js';

// EPUB selectorMap decode
export {
	expandBlockAnchor as expandEpubBlockAnchor,
	expandSelectorMap as expandEpubSelectorMap,
	resolveSelectorMap as resolveEpubSelectorMap,
	resolveSelectorMapRange as resolveEpubSelectorMapRange,
	parseSelectorMapEntries as parseEpubSelectorMapEntries,
	findCommonCFIPath,
} from './dom/epub/decode.js';

// Snapshot selectorMap decode
export {
	expandBlockAnchor as expandSnapshotBlockAnchor,
	expandSelectorMap as expandSnapshotSelectorMap,
	parseSelectorMap as parseSnapshotSelectorMap,
	parseSelectorMapEntries as parseSnapshotSelectorMapEntries,
	resolveSelectorMap as resolveSnapshotSelectorMap,
} from './dom/snapshot/decode.js';

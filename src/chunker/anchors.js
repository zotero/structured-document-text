import { PDFPositionMapper } from './pdf.js';
import { EPUBPositionMapper } from './epub.js';
import { SnapshotPositionMapper } from './snapshot.js';
import { getChains, getDocument, mergeSpans, readingOrder, spansText } from './document.js';
import { iterateChunks, outlinePathAt, pageLabel } from './chunks.js';

const formats = { pdf: PDFPositionMapper, epub: EPUBPositionMapper, snapshot: SnapshotPositionMapper };
const mappers = new WeakMap();

/**
 * Split text and attach source anchors before discarding source spans.
 * DOM element anchors provide locations for synthetic text; PDF text requires text maps.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./anchors').Chunk[]}
 */
export function getChunks(structure, options) {
	let mapper = getMapper(structure);
	if (!mapper) throw new TypeError('Unsupported SDT processor type');
	let chunks = [];
	for (let { spans, ...chunk } of iterateChunks(structure, options)) {
		let anchor;
		if (mapper instanceof PDFPositionMapper) anchor = mapper.toAnchor(spans);
		else {
			let selectors = mapper.toPositions(spans);
			anchor = selectors?.length && selectors.every(Boolean) ? { selectors } : null;
		}
		chunks.push({ ...chunk, anchor });
	}
	return chunks;
}

/**
 * Recover covered text without rerunning the chunker or inclusion policy:
 * the text with the section and page at its first recovered text.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {import('./text').ChunkContent | null}
 */
export function getAnchorContent(structure, anchor) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	let spans = getMapper(structure)?.toSpans(positions);
	if (!spans?.length) return null;
	let document = getDocument(structure);
	spans = readingOrder(document, mergeSpans(spans));
	let { entry, start } = spans[0];
	// A later part of a continued paragraph reads in the section its paragraph starts in
	let sectionEntry = document.entries[getChains(document)[entry.index]];
	return { text: spansText(spans), outlinePath: outlinePathAt(structure, sectionEntry.ref),
		pageLabel: pageLabel(structure, entry, start) };
}

/**
 * Convert an anchor to ordinary Reader positions. DOM conversion does not
 * certify text recovery; callers must handle getAnchorContent() failure separately.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {import('./anchors').Position[] | null}
 */
export function getAnchorPositions(structure, anchor) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	return structure.metadata?.processor?.type === 'pdf'
		? getMapper(structure).resolvePositions(positions) : positions;
}

// Validate the envelope and translate it to the existing mapper inputs.
// Group PDF rectangles by page so a missing page cannot silently disappear.
function readAnchor(structure, anchor) {
	if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
			|| 'nextPageRects' in anchor || 'nextPageIndex' in anchor) return null;
	let type = structure.metadata?.processor?.type;
	if (type === 'pdf') {
		if ('selectors' in anchor || !Array.isArray(anchor.pageRects) || !anchor.pageRects.length) return null;
		let pages = new Map();
		for (let rect of anchor.pageRects) {
			if (!Array.isArray(rect) || rect.length !== 5 || !Number.isInteger(rect[0]) || rect[0] < 0
					|| !rect.slice(1).every(Number.isFinite) || rect[1] > rect[3] || rect[2] > rect[4]) return null;
			if (!pages.has(rect[0])) pages.set(rect[0], []);
			pages.get(rect[0]).push(rect.slice(1));
		}
		return [...pages].map(([pageIndex, rects]) => ({ pageIndex, rects }));
	}
	if (type !== 'epub' && type !== 'snapshot' || 'pageRects' in anchor
			|| !Array.isArray(anchor.selectors) || !anchor.selectors.length) return null;
	for (let selector of anchor.selectors) if (!validSelector(selector, type)) return null;
	return anchor.selectors.map(selector => ({ ...selector,
		...(selector.refinedBy ? { refinedBy: { ...selector.refinedBy } } : {}) }));
}

function validSelector(selector, type) {
	if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return false;
	if (type === 'epub') return selector.type === 'FragmentSelector' && typeof selector.value === 'string' && !!selector.value;
	if (selector.type === 'TextPositionSelector') return validTextRange(selector);
	return selector.type === 'CssSelector' && typeof selector.value === 'string' && !!selector.value
		&& (selector.refinedBy == null || validTextRange(selector.refinedBy));
}

function validTextRange(selector) {
	return selector.type === 'TextPositionSelector' && Number.isSafeInteger(selector.start)
		&& Number.isSafeInteger(selector.end) && selector.start >= 0 && selector.end >= selector.start;
}

function getMapper(structure) {
	let type = structure.metadata?.processor?.type;
	let Mapper = Object.hasOwn(formats, type) && formats[type];
	if (!Mapper) return null;
	let document = getDocument(structure);
	if (!mappers.has(document)) {
		mappers.set(document, new Mapper(document));
	}
	return mappers.get(document);
}

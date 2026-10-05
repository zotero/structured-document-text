import type { StructuredDocumentText } from '../../schema.js';
import type { ChunkingOptions, ChunkContent, TextChunk } from './text.js';

export interface PDFPosition {
	pageIndex: number;
	rects: [number, number, number, number][];
	/** Existing adjacent-page Reader representation. */
	nextPageRects?: [number, number, number, number][];
}
export interface FragmentSelector {
	type: 'FragmentSelector';
	conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html';
	value: string;
}
export interface TextPositionSelector {
	type: 'TextPositionSelector';
	start: number;
	end: number;
}
export interface CssSelector {
	type: 'CssSelector';
	value: string;
	refinedBy?: TextPositionSelector;
}
/** Existing reader source positions; no multi-page extension to their shapes. */
export type Position = PDFPosition | FragmentSelector | TextPositionSelector | CssSelector;

export interface PDFChunkAnchor {
	pageRects: [pageIndex: number, left: number, bottom: number, right: number, top: number][];
}
export interface DOMChunkAnchor {
	selectors: (FragmentSelector | TextPositionSelector | CssSelector)[];
}
export type ChunkAnchor = PDFChunkAnchor | DOMChunkAnchor;

export interface Chunk extends TextChunk {
	/** Source coverage, which can exceed the chunk text; null if mapping fails. */
	anchor: ChunkAnchor | null;
}

/** Returns serializable chunks with source locations attached. DOM text may use broader element anchors.
 * Text without source anchors is omitted before chunking. Unresolvable mappings yield anchor: null.
 * Unsupported formats and unexpected programming errors still throw. */
export function getChunks(structure: StructuredDocumentText, options?: ChunkingOptions): Chunk[];
/** Reads covered text in document order, with the section and page at the first recovered text.
 * The text may differ from the chunk text or be empty after trimming.
 * Returns null for invalid anchors or unresolved pages/selectors. Individual empty PDF rectangles are tolerated. */
export function getAnchorContent(structure: StructuredDocumentText, anchor: ChunkAnchor | null): ChunkContent | null;
/** Restores ordinary PDF line positions, one per page, or copies DOM selectors.
 * DOM conversion does not verify text recovery or Reader resolution. */
export function getAnchorPositions(structure: StructuredDocumentText, anchor: ChunkAnchor | null): Position[] | null;

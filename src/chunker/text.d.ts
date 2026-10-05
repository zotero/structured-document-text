import type { StructuredDocumentText } from '../../schema.js';

/** Text selection, embedding formatting and defaults version; independent of position mapping, processor and schema versions. */
export const CHUNKER_VERSION: number;

export interface ChunkingOptions {
	/** Estimated embedText token ceiling, including context; integer >= 2, default 768. Mutually exclusive with maxSize. */
	maxTokens?: number;
	/** Hard embedText limit in UTF-16 units; integer >= 2. Omit for automatic sizing with maxTokens. */
	maxSize?: number;
	/** Preferred minimum in UTF-16 units. Defaults to roughly 120 tokens, scaled proportionally below maxTokens: 768, or 120/768 of explicit maxSize. */
	minSize?: number;
	/** Overlap in UTF-16 units. Defaults to roughly 48 tokens, scaled proportionally below maxTokens: 768, or 48/768 of explicit maxSize. */
	overlap?: number;
}

/** What a chunk has: its text, and the section and page at the first of it */
export interface ChunkContent {
	/** Selected source text, excluding headings safely replaced by embedding context. */
	text: string;
	/** Path at the first selected text; a chunk can contain several short sections. */
	outlinePath: string;
	/** First selected page's label, or PDF page ordinal when unlabeled. Null without a label or for synthetic EPUB locations. */
	pageLabel: string | null;
}

/** A chunk as cut, with what is derived for embedding. */
export interface TextChunk extends ChunkContent {
	/** Embedding input with selected outline paths inserted at section boundaries. */
	embedText: string;
	/** Rounded script-based estimate for embedText; not an exact model token count. */
	tokens: number;
	/** One-based passage number within this split group, which may combine short sections. */
	sectionPart: number;
	/** Total passages in this split group; 1 when unsplit. */
	sectionParts: number;
}

/** Returns source excerpts and embedding input without decoding geometry. Treat the structure as immutable. */
export function getTextChunks(structure: StructuredDocumentText, options?: ChunkingOptions): TextChunk[];

/** Returns the same count as getTextChunks without constructing outputs or decoding geometry. */
export function getChunkCount(structure: StructuredDocumentText, options?: ChunkingOptions): number;

/** Splits plain text with no structure: blank lines separate paragraphs; single newlines and form feeds read as spaces. */
export function getPlainTextChunks(text: string, options?: ChunkingOptions): TextChunk[];

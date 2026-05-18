import type { ContentBlockNode, PageContentRange, RefPath } from '../schema';

export function makeContentPoint(ref: RefPath, offset?: number): number[];
export function makeContentRange(
	startRef: RefPath,
	endRef: RefPath,
	startOffset?: number,
	endOffset?: number
): PageContentRange;
export function setContentRangeStart(range: PageContentRange, ref: RefPath, offset?: number): void;
export function setContentRangeEnd(range: PageContentRange, ref: RefPath, offset?: number): void;
export function splitContentPoint(point: unknown, content: ContentBlockNode[]): {
	ref: RefPath | null;
	offset?: number;
};
export function splitContentRange(range: PageContentRange, content: ContentBlockNode[]): {
	start: {
		ref: RefPath | null;
		offset?: number;
	};
	end: {
		ref: RefPath | null;
		offset?: number;
	};
};

import type { TextNode, ContentBlockNode, PageContentRange } from '../schema';

export function mergeTextNodes(textNodes: TextNode[]): TextNode[];
export function mergeNodesWithSelectorMap<T extends unknown[]>(content: T): T;
export function getBlockPlainText(block: ContentBlockNode): string;
export function getNestedBlockPlainText(block: ContentBlockNode): string;
export function getContentRange(content: ContentBlockNode[], startOffset: number, endOffset: number): PageContentRange;

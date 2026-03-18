import type { TextNode, ContentBlockNode } from '../../schema';

export function mergeSequentialTextNodes(textNodes: TextNode[]): TextNode[];
export function getBlockPlainText(block: ContentBlockNode): string;
export function getNestedBlockPlainText(block: ContentBlockNode): string;

import type { CssSelector } from '../../schema';

export function expandSelectorMap(blockSelectorMap: string, selectorMap: string): string;
export function expandBlockAnchor(blockSelectorMap: string): CssSelector;
export function parseSelectorMap(selectorMap: string): { selector: string; offset: number };
export function parseSelectorMapEntries(selectorMap: string): { length: number; selectorMap: string }[] | null;
export function resolveSelectorMap(selectorMap: string, start: number, end?: number): CssSelector;

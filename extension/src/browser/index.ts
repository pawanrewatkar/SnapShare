import { chromePlatform } from './chrome';
import type { BrowserPlatform } from './types';

/** Single entry point for browser APIs. Swap implementation per target browser at build time. */
export const platform: BrowserPlatform = chromePlatform;
export type { BrowserPlatform, TabInfo, KeyValueArea } from './types';

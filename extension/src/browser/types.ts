/**
 * Browser compatibility layer. Every extension API the app needs goes through this
 * interface so Edge/Firefox/Safari implementations can be added without touching features.
 */
export interface TabInfo {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
}

export interface KeyValueArea {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface BrowserPlatform {
  name: 'chrome';
  getActiveTab(): Promise<TabInfo | null>;
  getTab(tabId: number): Promise<TabInfo | null>;
  captureVisibleTab(windowId: number): Promise<string>;
  injectContentScript(tabId: number): Promise<void>;
  sendToTab<T = unknown>(tabId: number, message: unknown): Promise<T>;
  openExtensionPage(path: string, opts?: { active?: boolean }): Promise<TabInfo>;
  extensionUrl(path: string): string;
  closeTab(tabId: number): Promise<void>;
  focusTab(tabId: number): Promise<void>;
  download(url: string, filename: string, saveAs: boolean, headers?: { name: string; value: string }[]): Promise<number>;
  getTabMediaStreamId(targetTabId: number): Promise<string>;
  ensureOffscreen(path: string, reasons: string[], justification: string): Promise<void>;
  closeOffscreen(): Promise<void>;
  hasOffscreen(path: string): Promise<boolean>;
  getAuthToken(interactive: boolean, scopes: string[]): Promise<{ token: string; grantedScopes: string[] | null }>;
  removeCachedAuthToken(token: string): Promise<void>;
  clearAllCachedAuthTokens(): Promise<void>;
  oauthClientId(): string | null;
  setBadge(text: string, color?: string): Promise<void>;
  storage: { local: KeyValueArea; session: KeyValueArea; sync: KeyValueArea };
}

import type { BrowserPlatform, KeyValueArea, TabInfo } from './types';

const toTab = (t: chrome.tabs.Tab | undefined): TabInfo | null =>
  t && typeof t.id === 'number' ? { id: t.id, windowId: t.windowId, url: t.url, title: t.title } : null;

function area(getArea: () => chrome.storage.StorageArea | undefined): KeyValueArea {
  return {
    async get<T>(key: string) {
      const a = getArea();
      if (!a) return undefined;
      const r = await a.get(key);
      return r[key] as T | undefined;
    },
    async set(key, value) {
      await getArea()?.set({ [key]: value });
    },
    async remove(key) {
      await getArea()?.remove(key);
    },
  };
}

export const chromePlatform: BrowserPlatform = {
  name: 'chrome',
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return toTab(tab);
  },
  async getTab(tabId) {
    try {
      return toTab(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  },
  captureVisibleTab(windowId) {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  },
  async injectContentScript(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  },
  sendToTab<T>(tabId: number, message: unknown) {
    return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
  },
  async openExtensionPage(path, opts) {
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(path), active: opts?.active ?? true });
    const info = toTab(tab);
    if (!info) throw new Error('Could not open extension page');
    return info;
  },
  extensionUrl(path) {
    return chrome.runtime.getURL(path);
  },
  async closeTab(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already closed */
    }
  },
  async focusTab(tabId) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  },
  download(url, filename, saveAs) {
    return chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  },
  getTabMediaStreamId(targetTabId) {
    return chrome.tabCapture.getMediaStreamId({ targetTabId });
  },
  async ensureOffscreen(path, reasons, justification) {
    if (await this.hasOffscreen(path)) return;
    try {
      await chrome.offscreen.createDocument({ url: path, reasons: reasons as chrome.offscreen.Reason[], justification });
    } catch (e) {
      // A concurrent creation may already have succeeded.
      if (!(await this.hasOffscreen(path))) throw e;
    }
  },
  async closeOffscreen() {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* none open */
    }
  },
  async hasOffscreen(path) {
    const url = chrome.runtime.getURL(path);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [url],
    });
    return contexts.length > 0;
  },
  async launchWebAuthFlow(url) {
    const result = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    if (!result) throw new Error('Sign-in was cancelled');
    return result;
  },
  authRedirectUrl() {
    return chrome.identity.getRedirectURL('auth');
  },
  async setBadge(text, color) {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  },
  storage: {
    local: area(() => globalThis.chrome?.storage?.local),
    session: area(() => globalThis.chrome?.storage?.session),
    sync: area(() => globalThis.chrome?.storage?.sync),
  },
};

import 'fake-indexeddb/auto';
import { vi } from 'vitest';

/** Minimal in-memory chrome.* mock for unit tests (not a substitute for manual Chrome testing). */
function area() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(obj) };
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
    clear: () => {
      data = {};
    },
  };
}

const chromeMock = {
  storage: { local: area(), session: area(), sync: area(), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  runtime: { id: 'test', sendMessage: vi.fn(async () => undefined), onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, getURL: (p: string) => `chrome-extension://test/${p}` },
  identity: { getRedirectURL: (p: string) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${p}`, launchWebAuthFlow: vi.fn() },
};
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

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

export const identity = {
  token: 'tok-A' as string | null,
  grantedScopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'],
  error: null as string | null,
  removed: [] as string[],
  getAuthToken: vi.fn(async () => {
    if (identity.error) throw new Error(identity.error);
    if (!identity.token) throw new Error('The user is not signed in.');
    return { token: identity.token, grantedScopes: identity.grantedScopes };
  }),
  removeCachedAuthToken: vi.fn(async ({ token }: { token: string }) => void identity.removed.push(token)),
  clearAllCachedAuthTokens: vi.fn(async () => undefined),
};

const chromeMock = {
  storage: { local: area(), session: area(), sync: area(), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  runtime: {
    id: 'test',
    sendMessage: vi.fn(async () => undefined),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    getURL: (p: string) => `chrome-extension://test/${p}`,
    getManifest: () => ({ oauth2: { client_id: (globalThis as unknown as { __clientId: string }).__clientId } }),
  },
  identity,
};
(globalThis as unknown as { __clientId: string }).__clientId = '123-abc.apps.googleusercontent.com';
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

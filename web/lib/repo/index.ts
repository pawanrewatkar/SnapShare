import type { Repo } from './types';
import { SupabaseRepo } from './supabase';
import { MemoryRepo } from './memory';
import { sha256Hex } from '../crypto';

let instance: Repo | null = null;

/** Known tokens seeded in E2E memory mode (never active in production builds). */
export const E2E_TOKENS = { revoked: 'r'.repeat(43), expired: 'e'.repeat(43) };

function e2eRepo(): Repo {
  const m = new MemoryRepo();
  void (async () => {
    const u = await m.upsertUserFromGoogle({ sub: 'e2e', email: 'e2e@example.com', name: 'E2E', picture: null, scopes: [] });
    const a = await m.insertAsset({ userId: u.id, driveFileId: 'e2e-file', filename: 'e2e.png', mediaType: 'screenshot', mimeType: 'image/png', size: 1, width: 1, height: 1, durationMs: null, parentAssetId: null });
    const base = { assetId: a.id, userId: u.id, tokenCiphertext: 'x', accessType: 'restricted' as const, allowDownload: true, drivePermissionId: null };
    const r = await m.insertShare({ ...base, tokenHash: sha256Hex(E2E_TOKENS.revoked), expiresAt: null });
    await m.updateShare(r.id, { isActive: false, revokedAt: new Date().toISOString() });
    await m.insertShare({ ...base, tokenHash: sha256Hex(E2E_TOKENS.expired), expiresAt: new Date(Date.now() - 1000).toISOString() });
  })();
  return m;
}

export function repo(): Repo {
  if (!instance) {
    // In-memory mode for browser E2E tests only; refused in production.
    instance = process.env.SNAPSHARE_E2E_MEMORY === '1' && process.env.NODE_ENV !== 'production' ? e2eRepo() : new SupabaseRepo();
  }
  return instance;
}

/** Test hook to inject an in-memory repository. */
export function setRepo(r: Repo | null) {
  instance = r;
}

export type * from './types';

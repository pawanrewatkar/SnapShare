import type { MediaAsset, MediaType } from '@snapshare/shared';
import { api } from '@/services/api';
import type { CaptureMeta } from '@/services/db';

export type Category = 'all' | MediaType;

export interface GalleryItem {
  key: string;
  source: 'cloud' | 'local';
  id: string;
  filename: string;
  mediaType: MediaType;
  mimeType: string;
  size: number;
  createdAt: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: 'available' | 'missing';
  asset?: MediaAsset;
  local?: CaptureMeta;
}

export const listAssets = (category: Category, q: string) => {
  const p = new URLSearchParams();
  if (category !== 'all') p.set('type', category);
  if (q) p.set('q', q);
  return api<MediaAsset[]>(`/api/assets?${p}`);
};
export const renameAsset = (id: string, filename: string) => api<MediaAsset>(`/api/assets/${id}`, { method: 'PATCH', body: { filename } });
export const deleteAsset = (id: string) => api<void>(`/api/assets/${id}`, { method: 'DELETE' });
export const reconcileAssets = () => api<{ checked: number; missing: number; restored: number }>('/api/assets/reconcile', { method: 'POST' });
export const signedContentUrl = (id: string, download = false) => api<{ url: string; expiresAt: string }>(`/api/assets/${id}/signed-url${download ? '?download=1' : ''}`, { method: 'POST' });

/** Merges Drive assets and not-yet-uploaded local captures into one filtered, sorted list. */
export function mergeItems(assets: MediaAsset[], local: CaptureMeta[], category: Category, q: string, source: 'all' | 'cloud' | 'local'): GalleryItem[] {
  const query = q.trim().toLowerCase();
  const items: GalleryItem[] = [];
  if (source !== 'local')
    for (const a of assets)
      items.push({
        key: `c:${a.id}`,
        source: 'cloud',
        id: a.id,
        filename: a.filename,
        mediaType: a.mediaType,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: Date.parse(a.createdAt),
        width: a.width,
        height: a.height,
        durationMs: a.durationMs,
        status: a.status,
        asset: a,
      });
  if (source !== 'cloud')
    for (const l of local) {
      if (l.cloud) continue; // shown via its cloud asset
      items.push({
        key: `l:${l.id}`,
        source: 'local',
        id: l.id,
        filename: l.filename,
        mediaType: l.kind,
        mimeType: l.mimeType,
        size: l.size,
        createdAt: l.createdAt,
        width: l.width,
        height: l.height,
        durationMs: l.durationMs,
        status: 'available',
        local: l,
      });
    }
  return items
    .filter((i) => category === 'all' || i.mediaType === category)
    .filter((i) => !query || i.filename.toLowerCase().includes(query))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendChunk, deleteCapture, deleteChunks, getCapture, getChunks, getDraft, listCaptures, listChunkRecordingIds, putCapture, saveDraft, updateCapture, type CaptureRecord } from '@/services/db';
import { buildFilename, safeSubfolder } from '@/services/settings';
import { mergeItems } from '@/features/gallery/galleryApi';
import type { MediaAsset } from '@snapshare/shared';

const rec = (id: string, createdAt: number, extra: Partial<CaptureRecord> = {}): CaptureRecord => ({
  id,
  kind: 'screenshot',
  blob: new Blob(['x'], { type: 'image/png' }),
  mimeType: 'image/png',
  filename: `file-${id}`,
  size: 1,
  width: 1,
  height: 1,
  durationMs: null,
  createdAt,
  parentId: null,
  sourceUrl: null,
  sourceTitle: null,
  cloud: null,
  ...extra,
});

describe('local capture storage (IndexedDB)', () => {
  it('stores originals and edited versions separately', async () => {
    await putCapture(rec('orig', 1));
    await putCapture(rec('edit', 2, { kind: 'edited', parentId: 'orig' }));
    const list = await listCaptures();
    expect(list.map((c) => c.id).slice(0, 2)).toEqual(['edit', 'orig']);
    expect((await getCapture('orig'))?.kind).toBe('screenshot');
    expect((await getCapture('edit'))?.parentId).toBe('orig');
    expect('blob' in list[0]).toBe(false);
  });
  it('updates and deletes captures with their drafts', async () => {
    await putCapture(rec('d1', 3));
    await saveDraft('d1', { objects: [] });
    await updateCapture('d1', { filename: 'renamed' });
    expect((await getCapture('d1'))?.filename).toBe('renamed');
    await deleteCapture('d1');
    expect(await getCapture('d1')).toBeUndefined();
    expect(await getDraft('d1')).toBeUndefined();
  });
  it('persists recording chunks in order for crash recovery', async () => {
    await appendChunk('rec1', 1, new Blob(['b']));
    await appendChunk('rec1', 0, new Blob(['a']));
    await appendChunk('rec2', 0, new Blob(['z']));
    const chunks = await getChunks('rec1');
    expect(await new Blob(chunks).text()).toBe('ab');
    expect((await listChunkRecordingIds()).sort()).toEqual(['rec1', 'rec2']);
    await deleteChunks('rec1');
    expect(await getChunks('rec1')).toEqual([]);
  });
});

describe('settings helpers', () => {
  it('expands filename patterns safely', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(buildFilename('SnapShare {date} {time}', { date: d, kind: 'screenshot' })).toBe('SnapShare 2026-01-02 03-04-05');
    expect(buildFilename('{title}', { date: d, title: 'a/b:c*?"<>|', kind: 'x' })).toBe('a_b_c_');
    expect(buildFilename('', { date: d, kind: 'x' })).toMatch(/^SnapShare 2026/);
  });
  it('rejects path traversal in the download subfolder', () => {
    expect(safeSubfolder('../../etc/SnapShare')).toBe('etc/SnapShare');
    expect(safeSubfolder('a\\b')).toBe('a/b');
  });
});

describe('gallery merging', () => {
  const asset = (id: string, mediaType: MediaAsset['mediaType'], filename: string, createdAt: string): MediaAsset => ({
    id, driveFileId: `d${id}`, filename, mediaType, mimeType: mediaType === 'video' ? 'video/webm' : 'image/png', size: 1, width: null, height: null, durationMs: null, parentAssetId: null, status: 'available', isDrivePublic: false, createdAt, updatedAt: createdAt,
  });
  it('filters by category and search and hides local copies that were uploaded', () => {
    const assets = [asset('1', 'video', 'Demo recording', '2026-01-03T00:00:00Z'), asset('2', 'screenshot', 'Bug report', '2026-01-02T00:00:00Z')];
    const local = [
      { ...rec('l1', Date.parse('2026-01-04T00:00:00Z')), filename: 'Local bug' },
      { ...rec('l2', 1), cloud: { assetId: '2', driveFileId: 'd2', uploadedAt: 1 } },
    ];
    const all = mergeItems(assets, local, 'all', '', 'all');
    expect(all.map((i) => i.key)).toEqual(['l:l1', 'c:1', 'c:2']);
    expect(mergeItems(assets, local, 'video', '', 'all').map((i) => i.id)).toEqual(['1']);
    expect(mergeItems(assets, local, 'all', 'BUG', 'all').map((i) => i.id)).toEqual(['l1', '2']);
    expect(mergeItems(assets, local, 'all', '', 'cloud')).toHaveLength(2);
    expect(mergeItems(assets, local, 'all', '', 'local')).toHaveLength(1);
  });
});

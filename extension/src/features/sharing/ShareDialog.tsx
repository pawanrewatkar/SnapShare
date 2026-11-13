import { useCallback, useEffect, useState } from 'react';
import { Button, Modal, Spinner, useToast } from '@/components/ui';
import { friendlyError } from '@/services/api';
import { copyText } from '@/services/media';
import { drive, type DriveFile } from '@/features/drive/driveApi';
import { cachedFolders, ensureFolders, FOLDER_NAMES } from '@/features/drive/driveService';
import { analyzeSharing, fileUrl, isValidEmail, type FolderPermissions, type SharingState } from './permissions';

/** Loads the file's own permissions plus those of its SnapShare parent folders (inheritance check). */
export async function loadSharing(fileId: string): Promise<{ file: DriveFile; state: SharingState; folders: FolderPermissions[] }> {
  const file = await drive.getFile(fileId, 'id,name,mimeType,parents,webViewLink');
  const f = (await cachedFolders()) ?? (await ensureFolders());
  const names: Record<string, string> = { [f.root]: FOLDER_NAMES.root, [f.screenshots]: `${FOLDER_NAMES.root}/${FOLDER_NAMES.screenshots}`, [f.videos]: `${FOLDER_NAMES.root}/${FOLDER_NAMES.videos}` };
  const folderIds = [...new Set([...(file.parents ?? []), f.root])];
  const folders = await Promise.all(
    folderIds.map(async (id) => ({ folderId: id, folderName: names[id] ?? 'parent folder', permissions: await drive.listPermissions(id).catch(() => []) })),
  );
  const state = analyzeSharing(await drive.listPermissions(fileId), folders);
  return { file, state, folders };
}

/** Copies the original Drive URL of the single file (creates no permission). */
export async function copyDriveFileLink(fileId: string): Promise<string> {
  const file = await drive.getFile(fileId, 'id,webViewLink');
  const url = fileUrl(file.id, file.webViewLink);
  await copyText(url);
  return url;
}

export function ShareDialog({ fileId, filename, open, onClose }: { fileId: string; filename: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSharing>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAnyone, setConfirmAnyone] = useState(false);
  const [email, setEmail] = useState('');
  const [notify, setNotify] = useState(true);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await loadSharing(fileId));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [fileId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const run = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
      await load();
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const url = data ? fileUrl(data.file.id, data.file.webViewLink) : '';
  const st = data?.state;
  const anyoneDirect = st?.direct.find((p) => p.type === 'anyone');

  return (
    <Modal open={open} title={`Share “${filename}”`} onClose={onClose} wide>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !data || !st ? (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <p className="text-xs text-slate-500">
            Sharing applies to <b>this file only</b>. SnapShare never shares your SnapShare, Screenshots or Videos folders, and recipients cannot browse your other files.
          </p>

          <section className={`rounded-lg p-3 ${st.isPrivate ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200'}`}>
            <p className="font-medium">Current access: {st.summary}</p>
          </section>

          {st.inherited.length > 0 && (
            <section className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
              <p className="font-semibold">Warning: a parent folder is shared</p>
              <p className="mt-1 text-xs">
                Because these folder permissions are inherited, this file — and <b>every other file in that folder</b> — is accessible to the people below, even if you remove sharing from
                this file. Remove the folder sharing to keep your other files private.
              </p>
              <ul className="mt-2 space-y-1">
                {st.inherited.map((p) => (
                  <li key={`${p.folderId}-${p.id}`} className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      {p.type === 'anyone' ? 'Anyone with the link' : (p.emailAddress ?? p.domain ?? p.displayName)} ({p.role}) via <b>{p.folderName}</b>
                    </span>
                    <Button size="sm" variant="danger" loading={busy === `fold-${p.folderId}-${p.id}`} onClick={() => void run(`fold-${p.folderId}-${p.id}`, () => drive.deletePermission(p.folderId, p.id).then(() => toast('success', 'Folder sharing removed')))}>
                      Remove from folder
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-1 font-semibold">Share with specific Gmail addresses</h3>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const addr = email.trim();
                if (!isValidEmail(addr)) return toast('error', 'Enter a valid email address');
                void run('add', async () => {
                  await drive.createPermission(fileId, { type: 'user', emailAddress: addr }, notify);
                  await copyText(url).catch(() => undefined);
                  setEmail('');
                  toast('success', `Shared with ${addr} (viewer). Link copied.`);
                });
              }}
            >
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" className="min-w-0 flex-1 rounded border border-slate-300 bg-white p-1.5 dark:border-slate-600 dark:bg-slate-900" />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify by email
              </label>
              <Button size="sm" variant="primary" type="submit" loading={busy === 'add'}>
                Share (viewer)
              </Button>
            </form>
            <ul className="mt-2 space-y-1">
              {st.direct
                .filter((p) => p.type !== 'anyone')
                .map((p) => (
                  <li key={p.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-700">
                    <span>
                      {p.emailAddress ?? p.domain ?? p.displayName} <span className="text-slate-500">({p.role})</span>
                    </span>
                    <Button size="sm" variant="ghost" loading={busy === `rm-${p.id}`} onClick={() => void run(`rm-${p.id}`, () => drive.deletePermission(fileId, p.id).then(() => toast('success', 'Access removed')))}>
                      Remove
                    </Button>
                  </li>
                ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Anyone with the link</h3>
            {anyoneDirect ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs">Anyone who has the link can <b>view</b> this file.</span>
                <Button size="sm" variant="danger" loading={busy === 'anyone-off'} onClick={() => void run('anyone-off', () => drive.deletePermission(fileId, anyoneDirect.id).then(() => toast('success', 'Link access turned off')))}>
                  Turn off link access
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={confirmAnyone} onChange={(e) => setConfirmAnyone(e.target.checked)} className="mt-0.5" />
                  <span>
                    I understand that <b>anyone who gets this link</b> (including people I forward it to) can view this one file without signing in. My other files and folders stay private.
                  </span>
                </label>
                <Button
                  size="sm"
                  disabled={!confirmAnyone}
                  loading={busy === 'anyone-on'}
                  onClick={() =>
                    void run('anyone-on', async () => {
                      await drive.createPermission(fileId, { type: 'anyone' });
                      await copyText(url).catch(() => undefined);
                      setConfirmAnyone(false);
                      toast('success', 'Anyone with the link can view. Link copied.');
                    })
                  }
                >
                  Enable link access (viewer)
                </Button>
              </div>
            )}
          </section>

          <section className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
            <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" title={url}>
              {url}
            </code>
            <Button size="sm" onClick={() => void copyText(url).then(() => toast('success', st.isPrivate ? 'Link copied — the file is still private; only you can open it.' : 'Link copied'))}>
              Copy Drive link
            </Button>
            {st.direct.length > 0 && (
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'revoke-all'}
                onClick={() =>
                  void run('revoke-all', async () => {
                    for (const p of st.direct) await drive.deletePermission(fileId, p.id);
                    toast('success', st.inherited.length ? 'Direct sharing removed. Folder sharing still applies — see warning.' : 'Sharing revoked. The file is private.');
                  })
                }
              >
                Revoke all sharing for this file
              </Button>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

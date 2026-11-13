import { useCallback, useEffect, useState } from 'react';
import type { DrivePermission, ShareAccessType, ShareLink } from '@snapshare/shared';
import { Button, Modal, Spinner, useToast } from '@/components/ui';
import { api, friendlyError } from '@/services/api';
import { copyText } from '@/services/media';
import { getSettings } from '@/services/settings';

interface PermissionsResponse {
  permissions: DrivePermission[];
  webViewLink: string | null;
}

export const listShares = (assetId: string) => api<ShareLink[]>(`/api/assets/${assetId}/shares`);
export const createShare = (assetId: string, body: { accessType: ShareAccessType; expiresInDays: number | null; allowDownload: boolean }) =>
  api<ShareLink>(`/api/assets/${assetId}/shares`, { body });
export const revokeShare = (shareId: string) => api<void>(`/api/shares/${shareId}`, { method: 'DELETE' });

/** Returns the URL of an active share link, creating a private (restricted) one with user defaults if none exists. */
export async function getOrCreateShareUrl(assetId: string): Promise<string> {
  const existing = (await listShares(assetId)).find((s) => s.isActive && s.url && (!s.expiresAt || new Date(s.expiresAt) > new Date()));
  if (existing?.url) return existing.url;
  const st = await getSettings();
  const created = await createShare(assetId, { accessType: 'restricted', expiresInDays: st.defaultShareExpiryDays || null, allowDownload: st.shareAllowDownload });
  return created.url!;
}

function describeExpiry(s: ShareLink) {
  if (!s.isActive) return 'Revoked';
  if (!s.expiresAt) return 'Never expires';
  const d = new Date(s.expiresAt);
  return d < new Date() ? `Expired ${d.toLocaleDateString()}` : `Expires ${d.toLocaleString()}`;
}

export function ShareDialog({ assetId, filename, open, onClose }: { assetId: string; filename: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [perms, setPerms] = useState<PermissionsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [access, setAccess] = useState<ShareAccessType>('restricted');
  const [expiry, setExpiry] = useState<number>(7);
  const [allowDownload, setAllowDownload] = useState(true);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [confirmDrivePublic, setConfirmDrivePublic] = useState(false);
  const [email, setEmail] = useState('');
  const [notify, setNotify] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([listShares(assetId), api<PermissionsResponse>(`/api/assets/${assetId}/permissions`)]);
      setShares(s);
      setPerms(p);
    } catch (e) {
      toast('error', friendlyError(e));
    }
  }, [assetId, toast]);

  useEffect(() => {
    if (!open) return;
    void load();
    void getSettings().then((s) => {
      setAccess(s.defaultShareAccess);
      setExpiry(s.defaultShareExpiryDays);
      setAllowDownload(s.shareAllowDownload);
    });
  }, [open, load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const anyone = perms?.permissions.find((p) => p.type === 'anyone');
  const people = perms?.permissions.filter((p) => p.type === 'user' && p.role !== 'owner') ?? [];

  return (
    <Modal open={open} title={`Share “${filename}”`} onClose={onClose} wide>
      {!shares || !perms ? (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6 text-sm">
          <section>
            <h3 className="mb-1 font-semibold">SnapShare link</h3>
            <p className="mb-3 text-xs text-slate-500">
              Recipients open the file on the SnapShare website without installing anything. <b>Restricted</b> links keep the Drive file private — SnapShare checks the secret link,
              expiry and revocation before streaming the file. Anyone who has a restricted link can view it, so share it only with intended people.
            </p>
            <ul className="mb-3 space-y-2">
              {shares.length === 0 && <li className="text-xs text-slate-500">No links yet.</li>}
              {shares.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.accessType === 'public' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
                    {s.accessType === 'public' ? 'Public' : 'Restricted'}
                  </span>
                  <span className="text-xs text-slate-500">{describeExpiry(s)}</span>
                  <span className="text-xs text-slate-500">{s.allowDownload ? 'Download allowed' : 'View only'}</span>
                  <span className="ml-auto flex gap-1">
                    {s.isActive && s.url && (
                      <Button size="sm" onClick={() => void copyText(s.url!).then(() => toast('success', 'Link copied'), (e) => toast('error', friendlyError(e)))}>
                        Copy
                      </Button>
                    )}
                    {s.isActive && (
                      <Button size="sm" variant="danger" loading={busy === `revoke-${s.id}`} onClick={() => void run(`revoke-${s.id}`, async () => (await revokeShare(s.id), await load(), toast('success', 'Link revoked')))}>
                        Revoke
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs">
                Access
                <select value={access} onChange={(e) => (setAccess(e.target.value as ShareAccessType), setConfirmPublic(false))} className="rounded border border-slate-300 bg-white p-1.5 dark:border-slate-600 dark:bg-slate-900">
                  <option value="restricted">Restricted (Drive file stays private)</option>
                  <option value="public">Public (also public in Google Drive)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Expires
                <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} className="rounded border border-slate-300 bg-white p-1.5 dark:border-slate-600 dark:bg-slate-900">
                  <option value={1}>in 1 day</option>
                  <option value={7}>in 7 days</option>
                  <option value={30}>in 30 days</option>
                  <option value={0}>never</option>
                </select>
              </label>
              <label className="flex items-end gap-2 pb-1.5 text-xs">
                <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} /> Allow download
              </label>
              {access === 'public' && (
                <label className="flex items-start gap-2 rounded bg-amber-50 p-2 text-xs text-amber-900 sm:col-span-3 dark:bg-amber-950 dark:text-amber-200">
                  <input type="checkbox" checked={confirmPublic} onChange={(e) => setConfirmPublic(e.target.checked)} className="mt-0.5" />
                  I understand this changes the Google Drive permission so that <b>anyone with the link can view this file</b>, even after the SnapShare link expires, until I revoke it.
                </label>
              )}
              <div className="sm:col-span-3">
                <Button
                  variant="primary"
                  disabled={access === 'public' && !confirmPublic}
                  loading={busy === 'create'}
                  onClick={() =>
                    void run('create', async () => {
                      const s = await createShare(assetId, { accessType: access, expiresInDays: expiry || null, allowDownload });
                      if (s.url) await copyText(s.url).catch(() => undefined);
                      toast('success', 'Link created and copied');
                      setConfirmPublic(false);
                      await load();
                    })
                  }
                >
                  Create link
                </Button>
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-1 font-semibold">Google Drive sharing</h3>
            <p className="mb-2 text-xs text-slate-500">
              Current state:{' '}
              <b>{anyone ? 'Anyone with the Drive link can view' : people.length ? `Private · shared with ${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'Private (only you)'}</b>
            </p>
            <div className="mb-3 flex flex-wrap gap-2">
              {anyone ? (
                <>
                  <Button size="sm" onClick={() => perms.webViewLink && void copyText(perms.webViewLink).then(() => toast('success', 'Drive link copied'))}>
                    Copy Drive link
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === 'drive-private'}
                    onClick={() => void run('drive-private', async () => (await api(`/api/assets/${assetId}/permissions/${anyone.id}`, { method: 'DELETE' }), await load(), toast('success', 'Public Drive access removed')))}
                  >
                    Make private in Drive
                  </Button>
                </>
              ) : (
                <>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={confirmDrivePublic} onChange={(e) => setConfirmDrivePublic(e.target.checked)} className="mt-0.5" />
                    Allow anyone with the Google Drive link to view this file
                  </label>
                  <Button
                    size="sm"
                    disabled={!confirmDrivePublic}
                    loading={busy === 'drive-public'}
                    onClick={() =>
                      void run('drive-public', async () => {
                        const res = await api<PermissionsResponse>(`/api/assets/${assetId}/permissions`, { body: { type: 'anyone' } });
                        setPerms(res);
                        setConfirmDrivePublic(false);
                        if (res.webViewLink) await copyText(res.webViewLink).catch(() => undefined);
                        toast('success', 'Drive link enabled and copied');
                      })
                    }
                  >
                    Generate Drive link
                  </Button>
                </>
              )}
            </div>
            <p className="mb-1 text-xs font-medium">Share with specific Google accounts (Google verifies their identity)</p>
            <form
              className="mb-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run('add-user', async () => {
                  const res = await api<PermissionsResponse>(`/api/assets/${assetId}/permissions`, { body: { type: 'user', email, notify } });
                  setPerms(res);
                  setEmail('');
                  toast('success', `Shared with ${email}`);
                });
              }}
            >
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="min-w-0 flex-1 rounded border border-slate-300 bg-white p-1.5 dark:border-slate-600 dark:bg-slate-900" />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email them
              </label>
              <Button size="sm" type="submit" loading={busy === 'add-user'}>
                Add viewer
              </Button>
            </form>
            <ul className="space-y-1">
              {people.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-700">
                  <span>
                    {p.displayName ?? p.emailAddress} <span className="text-slate-500">({p.role})</span>
                  </span>
                  <Button size="sm" variant="ghost" loading={busy === `rm-${p.id}`} onClick={() => void run(`rm-${p.id}`, async () => (await api(`/api/assets/${assetId}/permissions/${p.id}`, { method: 'DELETE' }), await load()))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  );
}

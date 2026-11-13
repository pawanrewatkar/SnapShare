import { useEffect, useState, type ReactNode } from 'react';
import { formatBytes, type StorageQuota } from '@snapshare/shared';
import { mount } from './mount';
import { Button, Logo, Spinner, useToast } from '@/components/ui';
import { useSession, useSettings } from '@/hooks';
import { signIn, signOut } from '@/features/authentication/auth';
import { ensureFolders, getStorageQuota } from '@/features/drive/driveService';
import { API_BASE, friendlyError } from '@/services/api';
import { buildFilename, DEFAULT_SETTINGS } from '@/services/settings';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-3 font-semibold">{title}</h2>
      <div className="space-y-3 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-wrap items-center justify-between gap-2">
      <span>
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const input = 'rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800';

function SettingsPage() {
  const toast = useToast();
  const { session, loading } = useSession();
  const { settings, update } = useSettings();
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [driveState, setDriveState] = useState<'unknown' | 'checking' | 'connected' | 'error'>('unknown');
  const [driveError, setDriveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [micState, setMicState] = useState<string>('unknown');

  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        setMicState(p.state);
        p.onchange = () => setMicState(p.state);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session) return;
    setDriveState('checking');
    Promise.all([ensureFolders(), getStorageQuota()])
      .then(([, q]) => {
        setQuota(q);
        setDriveState('connected');
      })
      .catch((e) => {
        setDriveError(friendlyError(e));
        setDriveState('error');
      });
  }, [session]);

  const save = async (patch: Parameters<typeof update>[0]) => {
    await update(patch);
    toast('success', 'Saved');
  };

  if (!settings) return <Spinner />;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="flex items-center justify-between">
        <Logo />
        <a href="gallery.html" className="text-sm text-brand-600 hover:underline">
          Gallery
        </a>
      </header>

      <Section title="Google account">
        {loading ? (
          <Spinner />
        ) : session ? (
          <div className="flex flex-wrap items-center gap-3">
            {session.user.avatarUrl && <img src={session.user.avatarUrl} referrerPolicy="no-referrer" alt="" className="h-10 w-10 rounded-full" />}
            <div>
              <p className="font-medium">{session.user.name}</p>
              <p className="text-xs text-slate-500">{session.user.email}</p>
              <p className="text-xs text-slate-500">Session valid until {new Date(session.expiresAt).toLocaleString()}</p>
            </div>
            <Button className="ml-auto" variant="secondary" loading={busy} onClick={() => (setBusy(true), void signOut().finally(() => setBusy(false)))}>
              Sign out
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-slate-500">Not signed in. Sign in to save captures to your own Google Drive and share them.</p>
            <Button variant="primary" loading={busy} onClick={() => (setBusy(true), void signIn().catch((e) => toast('error', friendlyError(e))).finally(() => setBusy(false)))}>
              Sign in with Google
            </Button>
          </div>
        )}
        <p className="text-xs text-slate-500">
          SnapShare requests only your basic profile, email and the <code>drive.file</code> permission, which lets it see and manage <b>only files that SnapShare created</b> — never
          the rest of your Drive.
        </p>
      </Section>

      <Section title="Google Drive">
        <Row label="Connection">
          <span className={driveState === 'connected' ? 'text-emerald-600' : driveState === 'error' ? 'text-red-600' : 'text-slate-500'}>
            {!session ? 'Not connected' : driveState === 'checking' ? 'Checking…' : driveState === 'connected' ? 'Connected · folder SnapShare/ ready' : driveError}
          </span>
        </Row>
        {quota && (
          <Row label="Storage used">
            <span>
              {formatBytes(quota.usage)} {quota.limit ? `of ${formatBytes(quota.limit)}` : '(unlimited plan)'}
            </span>
          </Row>
        )}
        <Row label="Upload automatically after capture" hint="Otherwise upload from the editor, preview or gallery.">
          <input type="checkbox" checked={settings.autoUploadToDrive} onChange={(e) => void save({ autoUploadToDrive: e.target.checked })} />
        </Row>
        <p className="text-xs text-slate-500">Automatically uploaded files are private in your Drive; nothing is shared until you create a link.</p>
      </Section>

      <Section title="Capture">
        <Row label="Default capture mode" hint="Used by the Alt+Shift+S shortcut. Change keys at chrome://extensions/shortcuts.">
          <select className={input} value={settings.defaultCaptureMode} onChange={(e) => void save({ defaultCaptureMode: e.target.value as typeof settings.defaultCaptureMode })}>
            <option value="visible">Visible area</option>
            <option value="region">Selected region</option>
            <option value="fullpage">Full page</option>
            <option value="screen">Screen / window</option>
          </select>
        </Row>
        <Row label="Open the editor after capturing">
          <input type="checkbox" checked={settings.openEditorAfterCapture} onChange={(e) => void save({ openEditorAfterCapture: e.target.checked })} />
        </Row>
        <Row label="Hide sticky headers after the first full-page frame" hint="Prevents fixed headers repeating in full-page captures.">
          <input type="checkbox" checked={settings.hideFixedElementsOnFullPage} onChange={(e) => void save({ hideFixedElementsOnFullPage: e.target.checked })} />
        </Row>
        <Row label="Microphone permission" hint="Needed to narrate tab recordings.">
          <span className="flex items-center gap-2">
            <span className="text-slate-500">{micState}</span>
            {micState !== 'granted' && (
              <Button size="sm" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?for=microphone') })}>
                Grant
              </Button>
            )}
          </span>
        </Row>
      </Section>

      <Section title="Downloads">
        <Row label="Subfolder inside Downloads">
          <input className={input} defaultValue={settings.downloadSubfolder} onBlur={(e) => void save({ downloadSubfolder: e.target.value })} />
        </Row>
        <Row label="File name pattern" hint={`Tokens: {date} {time} {title} {kind}. Example: ${buildFilename(settings.filenamePattern, { title: 'Example page', kind: 'screenshot' })}`}>
          <input className={input} defaultValue={settings.filenamePattern} onBlur={(e) => void save({ filenamePattern: e.target.value || DEFAULT_SETTINGS.filenamePattern })} />
        </Row>
        <Row label="Ask where to save each file">
          <input type="checkbox" checked={settings.askWhereToSave} onChange={(e) => void save({ askWhereToSave: e.target.checked })} />
        </Row>
      </Section>

      <Section title="Privacy & sharing">
        <Row label="Default link type" hint="Restricted links keep the Drive file private.">
          <select className={input} value={settings.defaultShareAccess} onChange={(e) => void save({ defaultShareAccess: e.target.value as 'restricted' | 'public' })}>
            <option value="restricted">Restricted</option>
            <option value="public">Public (asks for confirmation each time)</option>
          </select>
        </Row>
        <Row label="Default link expiry">
          <select className={input} value={settings.defaultShareExpiryDays} onChange={(e) => void save({ defaultShareExpiryDays: Number(e.target.value) })}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </Row>
        <Row label="Allow recipients to download">
          <input type="checkbox" checked={settings.shareAllowDownload} onChange={(e) => void save({ shareAllowDownload: e.target.checked })} />
        </Row>
        <p className="text-xs text-slate-500">
          Uploaded files are always private by default. Nothing is made public unless you explicitly choose to. Read the{' '}
          <a className="underline" href={`${API_BASE}/privacy`} target="_blank" rel="noreferrer">
            privacy policy
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

mount(<SettingsPage />, 'SnapShare Settings');

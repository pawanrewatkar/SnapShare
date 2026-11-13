import { useCallback, useEffect, useState } from 'react';
import { getSession, type Session } from '@/services/api';
import { refreshAccount } from '@/features/authentication/auth';
import { getSettings, saveSettings, type Settings } from '@/services/settings';
import { sendBg } from '@/services/messaging';
import { INITIAL_RECORDING_STATE } from '@/features/recording/state';
import type { BroadcastMessage, RecordingState } from '@/types/messages';

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setSession(await getSession());
    setLoading(false);
  }, []);
  useEffect(() => {
    // Show the stored account immediately, then confirm it with Chrome's current Google account.
    void refresh().then(() => refreshAccount().then(() => refresh()));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'account' in changes) void refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [refresh]);
  return { session, loading, refresh };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => setSettings(await saveSettings(patch)), []);
  return { settings, update };
}

export function useRecordingState() {
  const [state, setState] = useState<RecordingState>(INITIAL_RECORDING_STATE);
  useEffect(() => {
    let alive = true;
    void sendBg<RecordingState>({ type: 'rec:status' }).then((s) => alive && setState(s), () => undefined);
    const onMsg = (m: BroadcastMessage) => {
      if (m?.type === 'rec:state') setState(m.state);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);
  return state;
}

/** Re-renders every `ms` while enabled (for timers). */
export function useNow(enabled: boolean, ms = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}

/** Creates an object URL for a blob and revokes it when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

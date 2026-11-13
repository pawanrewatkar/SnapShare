import type { BackgroundRequest } from '@/types/messages';

/** Sends a request to the service worker and unwraps {ok, result | error}. */
export async function sendBg<T = unknown>(msg: BackgroundRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string } | undefined;
  if (!res) throw new Error('SnapShare background is not responding. Try reloading the extension.');
  if (!res.ok) throw new Error(res.error ?? 'Request failed');
  return res.result as T;
}

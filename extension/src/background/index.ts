/**
 * MV3 service worker: routes messages, owns capture orchestration and the recording state machine.
 * Long-lived media work happens in the offscreen document / recorder page, never in the popup.
 */
import { platform } from '@/browser';
import type { BackgroundRequest, CaptureMode } from '@/types/messages';
import { completeRegion, runCapture } from './capture';
import { getSettings } from '@/services/settings';
import {
  getRecordingState,
  handleRecorderEvent,
  onTabRemoved,
  pauseRecording,
  reconcileOnStartup,
  resumeRecording,
  startRecording,
  stopRecording,
} from './recording';

async function handle(msg: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'capture':
      return runCapture(msg.mode, msg.tabId);
    case 'region:result':
      return completeRegion(msg.rect, msg.viewportWidth ?? 0, sender.tab?.id);
    case 'screen:captured':
      return { ok: true };
    case 'rec:start':
      return startRecording(msg.options);
    case 'rec:pause':
      return pauseRecording();
    case 'rec:resume':
      return resumeRecording();
    case 'rec:stop':
      return stopRecording();
    case 'rec:status':
      return getRecordingState();
    case 'rec:event':
      return handleRecorderEvent(msg.event);
    case 'open:editor':
      return platform.openExtensionPage(`editor.html?id=${encodeURIComponent(msg.captureId)}`);
    case 'open:page':
      return platform.openExtensionPage(`${msg.page}.html`);
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest & { target?: string }, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'recorder' || !('type' in msg)) return;
  if (sender.id !== chrome.runtime.id) return; // only accept messages from our own extension contexts
  const known = ['capture', 'region:result', 'screen:captured', 'rec:start', 'rec:pause', 'rec:resume', 'rec:stop', 'rec:status', 'rec:event', 'open:editor', 'open:page'];
  if (!known.includes(msg.type)) return;
  handle(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (e: Error) => sendResponse({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'capture-default') {
    const { defaultCaptureMode } = await getSettings();
    void runCapture(defaultCaptureMode);
    return;
  }
  const map: Record<string, CaptureMode> = { 'capture-visible': 'visible', 'capture-region': 'region', 'capture-fullpage': 'fullpage' };
  const mode = map[command];
  if (mode) void runCapture(mode);
});

chrome.tabs.onRemoved.addListener((tabId) => void onTabRemoved(tabId));

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  void chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
});

void reconcileOnStartup();

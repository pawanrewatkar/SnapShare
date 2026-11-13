import { useState } from 'react';
import { mount } from './mount';
import { Button, Logo } from '@/components/ui';
import { micErrorMessage } from '@/features/recording/audio';

/**
 * Offscreen documents cannot show permission prompts, so microphone access for tab recording
 * is granted once here, in a visible extension page.
 */
function Permissions() {
  const [state, setState] = useState<'idle' | 'granted' | 'error'>('idle');
  const [err, setErr] = useState('');
  const request = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setState('granted');
    } catch (e) {
      setErr(micErrorMessage(e));
      setState('error');
    }
  };
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      <h1 className="text-xl font-semibold">Allow microphone access</h1>
      <p className="text-sm text-slate-500">SnapShare uses your microphone only while you record with “Microphone” enabled. Audio is saved into your recording and never sent anywhere else.</p>
      {state === 'granted' ? (
        <>
          <p className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">Microphone access granted. Open the SnapShare popup and start recording.</p>
          <Button onClick={() => window.close()}>Close this tab</Button>
        </>
      ) : (
        <>
          {state === 'error' && (
            <p className="rounded bg-red-50 p-3 text-sm text-red-700">
              Could not get access: {err}. If you blocked it, click the icon in the address bar or open chrome://settings/content/microphone to allow SnapShare.
            </p>
          )}
          <Button variant="primary" onClick={() => void request()}>
            Allow microphone
          </Button>
        </>
      )}
    </div>
  );
}

mount(<Permissions />, 'SnapShare Permissions');

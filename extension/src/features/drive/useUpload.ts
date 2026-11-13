import { useCallback, useRef, useState } from 'react';
import type { DriveFile } from './driveApi';
import { useToast } from '@/components/ui';
import { friendlyError } from '@/services/api';
import { isReauthError, signIn } from '@/features/authentication/auth';
import { uploadCapture } from './driveService';
import { DriveError } from './upload';

export function uploadErrorMessage(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.code === 'quota') return e.message;
    if (e.code === 'network') return 'Upload interrupted by a network error. Retry to resume where it stopped.';
    if (e.code === 'auth') return 'Google authorization expired. Please sign in again.';
    if (e.code === 'aborted') return 'Upload cancelled.';
    return e.message;
  }
  return friendlyError(e);
}

/** Upload with progress, cancel, and one-shot re-authentication when the Google grant expired. */
export function useUpload() {
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const upload = useCallback(
    async (captureId: string): Promise<DriveFile | null> => {
      setUploading(true);
      setProgress(0);
      ctrl.current = new AbortController();
      const attempt = () => uploadCapture(captureId, (p) => setProgress(p.total ? p.sent / p.total : null), ctrl.current!.signal);
      try {
        let asset: DriveFile;
        try {
          asset = await attempt();
        } catch (e) {
          if (!isReauthError(e) && !(e instanceof DriveError && e.code === 'auth')) throw e;
          if ((e as { code?: string }).code === 'not_configured') throw e;
          toast('info', 'Please sign in to Google to continue the upload.');
          await signIn();
          asset = await attempt();
        }
        toast('success', 'Uploaded to Google Drive');
        return asset;
      } catch (e) {
        toast('error', uploadErrorMessage(e));
        return null;
      } finally {
        setUploading(false);
        setProgress(null);
        ctrl.current = null;
      }
    },
    [toast],
  );

  const cancel = useCallback(() => ctrl.current?.abort(), []);
  return { upload, uploading, progress, cancel };
}

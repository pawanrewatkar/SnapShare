import { requireUser } from '@/lib/auth';
import { driveFor, mapDriveError } from '@/lib/driveAccess';
import { handler, json, preflight } from '@/lib/http';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const GET = handler(async (req) => {
  const { userId } = await requireUser(req);
  try {
    return json(await (await driveFor(userId)).about());
  } catch (e) {
    mapDriveError(e, userId);
  }
});

import type { DriveFile, DrivePermission } from '@/features/drive/driveApi';

/**
 * In-memory fake of the Drive v3 endpoints SnapShare calls, with per-account visibility
 * (drive.file semantics: an account only sees files it created or that were shared with it).
 * Mocked: proves our logic only — NOT real Google Drive behaviour.
 */
export class FakeDrive {
  files = new Map<string, DriveFile & { owner: string }>();
  perms = new Map<string, (DrivePermission & { grantee?: string })[]>();
  seq = 0;
  currentAccount = 'A';
  emails: Record<string, string> = { A: 'a@gmail.com', B: 'b@gmail.com' };

  canSee(id: string, account = this.currentAccount) {
    const f = this.files.get(id);
    if (!f) return false;
    if (f.owner === account) return true;
    const direct = this.perms.get(id) ?? [];
    const inherited = (f.parents ?? []).flatMap((p) => this.perms.get(p) ?? []);
    return [...direct, ...inherited].some((p) => p.type === 'anyone' || p.emailAddress === this.emails[account]);
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const notFound = () => j({ error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404);
    const m = /\/files(?:\/([^/]+))?(?:\/permissions(?:\/([^/]+))?)?$/.exec(u.pathname);
    if (!m) return j({}, 400);
    const [, rawId, rawPerm] = m;
    const id = rawId && decodeURIComponent(rawId);
    const permId = rawPerm && decodeURIComponent(rawPerm);
    const isPerm = u.pathname.includes('/permissions');
    if (!id && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const nid = `f${++this.seq}`;
      this.files.set(nid, { id: nid, name: body.name, mimeType: body.mimeType, parents: body.parents, appProperties: body.appProperties, owner: this.currentAccount, createdTime: new Date(1700000000000 + this.seq).toISOString() });
      this.perms.set(nid, [{ id: `owner-${this.currentAccount}`, type: 'user', role: 'owner', emailAddress: this.emails[this.currentAccount] }]);
      return j({ id: nid, name: body.name });
    }
    if (!id) {
      const q = u.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const folders = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const noFolders = q.includes("mimeType != 'application/vnd.google-apps.folder'");
      const list = [...this.files.values()].filter(
        (f) => f.owner === this.currentAccount && !f.trashed && (!parent || f.parents?.includes(parent)) && (!name || f.name === name) && (!folders || f.mimeType.includes('folder')) && (!noFolders || !f.mimeType.includes('folder')),
      );
      return j({ files: list.map(({ owner: _o, ...f }) => f) });
    }
    if (!this.canSee(id)) return notFound();
    const f = this.files.get(id)!;
    if (isPerm) {
      if (f.owner !== this.currentAccount) return j({ error: { message: 'Insufficient permissions' } }, 403);
      if (method === 'GET') return j({ permissions: this.perms.get(id) ?? [] });
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        const p: DrivePermission = { id: body.type === 'anyone' ? 'anyoneWithLink' : `u-${body.emailAddress}`, type: body.type, role: body.role, emailAddress: body.emailAddress };
        this.perms.set(id, [...(this.perms.get(id) ?? []).filter((x) => x.id !== p.id), p]);
        // My Drive: folder grants propagate to children with the same id
        return j(p);
      }
      if (method === 'DELETE') {
        this.perms.set(id, (this.perms.get(id) ?? []).filter((x) => x.id !== permId));
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'GET') {
      if (u.searchParams.get('alt') === 'media') return new Response(new Blob(['bytes']));
      const { owner: _o, ...rest } = f;
      return j({ ...rest, webViewLink: `https://drive.google.com/file/d/${id}/view?usp=drivesdk` });
    }
    if (f.owner !== this.currentAccount) return j({ error: { message: 'Insufficient permissions' } }, 403);
    if (method === 'PATCH') {
      f.name = JSON.parse(String(init.body)).name;
      return j(f);
    }
    if (method === 'DELETE') {
      this.files.delete(id);
      return new Response(null, { status: 204 });
    }
    return j({}, 400);
  };
}

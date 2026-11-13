import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function Privacy() {
  return (
    <article className="prose mx-auto max-w-3xl px-4 py-12 text-sm leading-6 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
      <h1 className="text-2xl font-bold">Privacy Policy</h1>
      <p className="text-slate-500">Draft — must be reviewed by the operator and legal counsel before public release. Replace the bracketed operator details.</p>
      <h2>Who we are</h2>
      <p>SnapShare is operated by [Operator legal name, address, contact email].</p>
      <h2>What SnapShare accesses</h2>
      <ul>
        <li>Google account basics: your name, email address and profile picture (OpenID Connect scopes <code>openid email profile</code>).</li>
        <li>
          Google Drive, limited to the <code>drive.file</code> scope: SnapShare can only create, read, rename, share and delete files and folders that SnapShare itself created. It cannot see any
          other files in your Drive.
        </li>
        <li>Page content of the tab you explicitly capture or record, only when you start a capture or recording.</li>
        <li>Your microphone, only while you record with the microphone option enabled.</li>
      </ul>
      <h2>Where your media is stored</h2>
      <p>
        Screenshots, edited images and recordings are stored on your device (browser storage) and, when you choose to upload, in a <b>SnapShare</b> folder in <b>your own</b> Google Drive.
        SnapShare servers do not store your media. When a recipient opens a SnapShare link, the file is streamed from your Drive through our server without being stored.
      </p>
      <h2>What our servers store</h2>
      <ul>
        <li>Account profile (name, email, avatar URL) and your Google account identifier.</li>
        <li>An encrypted Google refresh token, used only to perform the Drive actions you request and to serve links you create. It is never shown to anyone.</li>
        <li>File metadata (Drive file ID, name, type, size, dimensions, dates) and share-link settings. Share tokens are stored as one-way hashes plus an encrypted copy so you can copy your link again.</li>
        <li>Security and activity logs (sign-in, upload, share, delete events) and rate-limiting counters.</li>
      </ul>
      <h2>Sharing</h2>
      <p>Files are private by default. A file becomes accessible to others only when you create a share link or change its Google Drive sharing. You can revoke links at any time.</p>
      <h2>Use of Google user data</h2>
      <p>
        SnapShare’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. We do not sell
        data, use it for advertising, or use it to train AI models.
      </p>
      <h2>Retention and deletion</h2>
      <p>
        Deleting a file in SnapShare deletes it from your Drive and removes its metadata. You can disconnect SnapShare at https://myaccount.google.com/permissions and request account deletion
        at [contact email]; we delete your account data within 30 days.
      </p>
      <h2>Security</h2>
      <p>Data in transit uses HTTPS. Secrets are encrypted at rest (AES-256-GCM). Database access is restricted with row-level security.</p>
      <h2>Contact</h2>
      <p>[Contact email]</p>
    </article>
  );
}

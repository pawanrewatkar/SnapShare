import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function Terms() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 text-sm leading-6 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold">
      <h1 className="text-2xl font-bold">Terms of Service</h1>
      <p className="text-slate-500">Draft — must be reviewed by the operator and legal counsel before public release.</p>
      <h2>1. The service</h2>
      <p>SnapShare provides a browser extension and website for capturing, editing, recording and sharing media stored in your own Google Drive.</p>
      <h2>2. Your content</h2>
      <p>You retain all rights to your content. You are responsible for having the right to capture, record and share it, including obtaining consent from people you record.</p>
      <h2>3. Acceptable use</h2>
      <p>Do not use SnapShare to share illegal content, infringe others’ rights, distribute malware, or circumvent access controls. We may disable share links that violate these terms.</p>
      <h2>4. Third-party services</h2>
      <p>SnapShare depends on Google services. Your use of Google Drive is also governed by Google’s terms.</p>
      <h2>5. Disclaimer and liability</h2>
      <p>The service is provided “as is”. To the extent permitted by law, [Operator] is not liable for indirect or consequential damages or for loss of data stored in third-party services.</p>
      <h2>6. Changes and termination</h2>
      <p>We may update these terms with notice. You may stop using SnapShare at any time and revoke its Google access.</p>
      <h2>7. Contact</h2>
      <p>[Operator legal name and contact email]</p>
    </article>
  );
}

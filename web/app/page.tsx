export default function Home() {
  const features = [
    ['Four capture modes', 'Visible area, selected region, full scrolling page, or any screen/window.'],
    ['Real editor', 'Arrows, shapes, highlights, comments, crop and true pixel blur for sensitive data.'],
    ['Screen recording', 'Record a tab or your screen with microphone and tab/system audio where Chrome supports it.'],
    ['Your Drive, your data', 'Files go to SnapShare/ in your own Google Drive. We only store metadata.'],
    ['Private by default', 'Nothing is public until you choose. Links can expire and be revoked any time.'],
    ['Branded links', 'Recipients view screenshots and videos in the browser — no install needed.'],
  ];
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <h1 className="text-4xl font-bold tracking-tight">Screenshots and recordings, shared from your own Google Drive.</h1>
      <p className="mt-4 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
        SnapShare is a Chrome extension for capturing, annotating, recording and sharing. It uses the minimal <code>drive.file</code> permission, so it can only see files it created.
      </p>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(([t, d]) => (
          <li key={t} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{d}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

import Link from 'next/link';

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          
          <img src="/icon.png" alt="" width={28} height={28} />
          SnapShare
        </Link>
        <nav className="flex gap-4 text-sm text-slate-600 dark:text-slate-300">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-500 dark:border-slate-800">
      SnapShare stores your media in your own Google Drive. ·{' '}
      <Link className="underline" href="/privacy">
        Privacy
      </Link>{' '}
      ·{' '}
      <Link className="underline" href="/terms">
        Terms
      </Link>
    </footer>
  );
}

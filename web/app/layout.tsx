import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/chrome';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SnapShare', template: '%s · SnapShare' },
  description: 'Capture, annotate, record and share — stored in your own Google Drive.',
  icons: { icon: '/icon.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

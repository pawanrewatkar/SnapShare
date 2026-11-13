import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@/components/ui';
import '@/styles.css';

export function mount(node: ReactNode, title?: string) {
  if (title) document.title = title;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ToastProvider>{node}</ToastProvider>
    </StrictMode>,
  );
}

/**
 * Injected on demand (chrome.scripting) into the page being captured.
 * Provides: region-selection overlay, page metrics, scrolling and fixed-element handling for full-page capture,
 * and an in-page progress indicator. Self-contained IIFE — no imports from extension chunks at runtime.
 */
import type { ContentRequest, PageMetrics } from '@/types/messages';
import { normalizeRect } from '@/features/screenshot/stitch';

declare global {
  interface Window {
    __snapshareContent?: boolean;
  }
}

const Z = '2147483647';

(function init() {
  if (window.__snapshareContent) return;
  window.__snapshareContent = true;

  let scroller: Element | null = null; // null → window scrolling
  let saved: { x: number; y: number; behavior: string; scrollerTop: number } | null = null;
  const hidden: { el: HTMLElement; value: string; priority: string }[] = [];
  let progressHost: HTMLElement | null = null;
  let hideFixedEnabled = true;

  const isWindowScroll = () => scroller === null;

  function findScroller(): Element | null {
    const doc = document.scrollingElement ?? document.documentElement;
    if (doc.scrollHeight > window.innerHeight + 2) return null;
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < window.innerHeight * 0.4) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function clipRect() {
    if (!scroller) return { x: 0, y: 0, width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    const r = scroller.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, window.innerWidth), height: Math.min(scroller.clientHeight, window.innerHeight) };
  }

  function metrics(): PageMetrics & { clip: ReturnType<typeof clipRect>; innerWidth: number } {
    const doc = document.scrollingElement ?? document.documentElement;
    const clip = clipRect();
    return {
      scrollHeight: scroller ? scroller.scrollHeight : Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
      scrollWidth: scroller ? scroller.scrollWidth : doc.scrollWidth,
      viewportHeight: scroller ? scroller.clientHeight : window.innerHeight,
      viewportWidth: clip.width,
      scrollX: window.scrollX,
      scrollY: scroller ? scroller.scrollTop : window.scrollY,
      dpr: window.devicePixelRatio || 1,
      clip,
      innerWidth: window.innerWidth,
    };
  }

  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function scrollToY(y: number): Promise<number> {
    if (isWindowScroll()) window.scrollTo({ left: 0, top: y, behavior: 'instant' as ScrollBehavior });
    else (scroller as Element).scrollTop = y;
    await nextFrame();
    await wait(120);
    return isWindowScroll() ? window.scrollY : (scroller as Element).scrollTop;
  }

  function hideFixedElements() {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (progressHost && (el === progressHost || progressHost.contains(el))) continue;
      hidden.push({ el, value: el.style.getPropertyValue('visibility'), priority: el.style.getPropertyPriority('visibility') });
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  function restoreFixedElements() {
    for (const h of hidden.splice(0)) {
      if (h.value) h.el.style.setProperty('visibility', h.value, h.priority);
      else h.el.style.removeProperty('visibility');
    }
  }

  /** Scrolls through the page once so lazy-loaded content (images, infinite sections) renders before capture. */
  async function preloadLazyContent() {
    const m = metrics();
    const step = Math.max(200, m.viewportHeight);
    const limit = Math.min(m.scrollHeight, 60_000);
    for (let y = 0; y < limit; y += step) {
      await scrollToY(y);
      await wait(60);
    }
    // Wait briefly for images that started loading.
    const pending = Array.from(document.images).filter((img) => !img.complete && img.loading !== 'lazy');
    await Promise.race([Promise.all(pending.map((img) => new Promise<void>((r) => {
      img.addEventListener('load', () => r(), { once: true });
      img.addEventListener('error', () => r(), { once: true });
    }))), wait(1500)]);
    await scrollToY(0);
  }

  function showProgress(label: string, progress: number | null) {
    if (!progressHost) {
      progressHost = document.createElement('div');
      progressHost.setAttribute('data-snapshare', 'progress');
      const shadow = progressHost.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        .box{position:fixed;right:16px;bottom:16px;z-index:${Z};background:#111827;color:#fff;font:13px system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);min-width:200px}
        .bar{height:4px;background:#374151;border-radius:2px;margin-top:8px;overflow:hidden}.fill{height:100%;background:#6366f1;width:0;transition:width .2s}
      </style><div class="box"><div class="label"></div><div class="bar"><div class="fill"></div></div></div>`;
      document.documentElement.appendChild(progressHost);
    }
    const shadow = progressHost.shadowRoot!;
    shadow.querySelector('.label')!.textContent = label;
    (shadow.querySelector('.fill') as HTMLElement).style.width = progress === null ? '100%' : `${Math.round(progress * 100)}%`;
  }

  function setProgressVisible(visible: boolean) {
    if (progressHost) progressHost.style.display = visible ? '' : 'none';
  }

  function removeProgress() {
    progressHost?.remove();
    progressHost = null;
  }

  function startRegionSelection() {
    const host = document.createElement('div');
    host.setAttribute('data-snapshare', 'region');
    const shadow = host.attachShadow({ mode: 'open' });
    // High-contrast crosshair: dark outline with a white core, visible on light and dark pages.
    const cross =
      `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>` +
      `<path d='M16 2v28M2 16h28' stroke='black' stroke-width='4' stroke-linecap='round'/>` +
      `<path d='M16 3v26M3 16h26' stroke='white' stroke-width='2'/></svg>`;
    const crossCursor = `url("data:image/svg+xml,${encodeURIComponent(cross)}") 16 16, crosshair`;
    shadow.innerHTML = `<style>
      .layer{position:fixed;inset:0;z-index:${Z};cursor:${crossCursor};user-select:none}
      .shade{position:absolute;background:rgba(15,23,42,.45);pointer-events:none}
      .sel{position:absolute;outline:2px solid #6366f1;box-shadow:0 0 0 1px rgba(255,255,255,.6) inset;pointer-events:none}
      .h{position:absolute;width:8px;height:8px;background:#fff;border:1.5px solid #6366f1;border-radius:2px;margin:-5px 0 0 -5px}
      .sel.dragging .h{display:none}
      .dims{position:absolute;background:#111827;color:#fff;font:12px system-ui,sans-serif;padding:3px 6px;border-radius:4px;pointer-events:none;white-space:nowrap}
      .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;font:13px system-ui,sans-serif;padding:8px 12px;border-radius:8px;pointer-events:none}
      .actions{position:absolute;display:none;gap:6px}
      button{font:600 12px system-ui,sans-serif;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
      .ok{background:#6366f1;color:#fff}.cancel{background:#fff;color:#111827}
    </style>
    <div class="layer"><div class="shade s1"></div><div class="shade s2"></div><div class="shade s3"></div><div class="shade s4"></div>
    <div class="sel" hidden>${['0,0', '50,0', '100,0', '0,50', '100,50', '0,100', '50,100', '100,100']
      .map((p) => `<div class="h" style="left:${p.split(',')[0]}%;top:${p.split(',')[1]}%"></div>`)
      .join('')}</div><div class="dims" hidden></div>
    <div class="actions"><button class="cancel">Cancel (Esc)</button><button class="ok">Capture (Enter)</button></div>
    <div class="hint">Drag to select an area · drag the selection to move or its edges to resize · Esc to cancel</div></div>`;
    document.documentElement.appendChild(host);
    const layer = shadow.querySelector('.layer') as HTMLElement;
    const sel = shadow.querySelector('.sel') as HTMLElement;
    const dims = shadow.querySelector('.dims') as HTMLElement;
    const actions = shadow.querySelector('.actions') as HTMLElement;
    const hint = shadow.querySelector('.hint') as HTMLElement;
    const shades = Array.from(shadow.querySelectorAll<HTMLElement>('.shade'));
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    type Edges = { l: boolean; r: boolean; t: boolean; b: boolean };
    type Drag =
      | { mode: 'new'; x: number; y: number }
      | { mode: 'move' | 'resize'; x: number; y: number; orig: typeof rect; edges?: Edges };
    let drag: Drag | null = null;
    let done = false;

    const paint = () => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const { x, y, width, height } = rect;
      const has = width > 0 && height > 0;
      sel.hidden = !has;
      dims.hidden = !has;
      Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      dims.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      Object.assign(dims.style, { left: `${x}px`, top: `${Math.max(0, y - 24)}px` });
      if (!has) {
        Object.assign(shades[0].style, { left: '0', top: '0', width: `${W}px`, height: `${H}px` });
        for (const s of shades.slice(1)) s.style.width = '0';
        return;
      }
      Object.assign(shades[0].style, { left: '0', top: '0', width: `${W}px`, height: `${y}px` });
      Object.assign(shades[1].style, { left: '0', top: `${y + height}px`, width: `${W}px`, height: `${H - y - height}px` });
      Object.assign(shades[2].style, { left: '0', top: `${y}px`, width: `${x}px`, height: `${height}px` });
      Object.assign(shades[3].style, { left: `${x + width}px`, top: `${y}px`, width: `${W - x - width}px`, height: `${height}px` });
    };

    const finish = async (confirmed: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      await nextFrame();
      await wait(50);
      if (confirmed && rect.width >= 4 && rect.height >= 4) {
        chrome.runtime.sendMessage({ type: 'region:result', rect, viewportWidth: window.innerWidth, dpr: window.devicePixelRatio || 1 });
      } else {
        chrome.runtime.sendMessage({ type: 'region:result', rect: null });
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      } else if (e.key === 'Enter' && rect.width > 0) {
        e.preventDefault();
        e.stopPropagation();
        void finish(true);
      }
    };
    window.addEventListener('keydown', onKey, true);

    /** What the pointer is over: an edge/corner of the selection (resize), its inside (move) or nothing. */
    const hitTest = (px: number, py: number): { mode: 'move' } | { mode: 'resize'; edges: Edges } | null => {
      if (rect.width <= 0 || rect.height <= 0) return null;
      const T = 8;
      const { x, y, width: w, height: h } = rect;
      if (px < x - T || px > x + w + T || py < y - T || py > y + h + T) return null;
      const edges = { l: Math.abs(px - x) <= T, r: Math.abs(px - (x + w)) <= T, t: Math.abs(py - y) <= T, b: Math.abs(py - (y + h)) <= T };
      if (edges.l || edges.r || edges.t || edges.b) return { mode: 'resize', edges };
      return px > x && px < x + w && py > y && py < y + h ? { mode: 'move' } : null;
    };

    const cursorFor = (hit: ReturnType<typeof hitTest>) => {
      if (!hit) return '';
      if (hit.mode === 'move') return 'move';
      const { l, r, t, b } = hit.edges;
      if ((l && t) || (r && b)) return 'nwse-resize';
      if ((r && t) || (l && b)) return 'nesw-resize';
      return l || r ? 'ew-resize' : 'ns-resize';
    };

    const showActions = () => {
      actions.style.display = 'flex';
      const below = rect.y + rect.height + 40 < window.innerHeight;
      Object.assign(actions.style, {
        left: `${Math.max(4, Math.min(rect.x + rect.width - 200, window.innerWidth - 210))}px`,
        top: below ? `${rect.y + rect.height + 8}px` : `${Math.max(4, rect.y + 8)}px`,
      });
    };

    layer.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON' || e.button !== 0) return;
      actions.style.display = 'none';
      hint.style.display = 'none';
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        drag = { mode: hit.mode, x: e.clientX, y: e.clientY, orig: { ...rect }, edges: hit.mode === 'resize' ? hit.edges : undefined };
      } else {
        drag = { mode: 'new', x: e.clientX, y: e.clientY };
        rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
      }
      sel.classList.add('dragging');
      paint();
    });
    layer.addEventListener('mousemove', (e) => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      if (!drag) {
        layer.style.cursor = cursorFor(hitTest(e.clientX, e.clientY));
        return;
      }
      if (drag.mode === 'new') {
        rect = normalizeRect(drag.x, drag.y, e.clientX, e.clientY, W, H);
      } else if (drag.mode === 'move') {
        const o = drag.orig;
        rect = {
          ...o,
          x: Math.max(0, Math.min(W - o.width, o.x + e.clientX - drag.x)),
          y: Math.max(0, Math.min(H - o.height, o.y + e.clientY - drag.y)),
        };
      } else {
        const o = drag.orig;
        const ed = drag.edges!;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        rect = normalizeRect(
          o.x + (ed.l ? dx : 0),
          o.y + (ed.t ? dy : 0),
          o.x + o.width + (ed.r ? dx : 0),
          o.y + o.height + (ed.b ? dy : 0),
          W,
          H,
        );
      }
      paint();
    });
    layer.addEventListener('mouseup', (e) => {
      if (!drag) return;
      drag = null;
      sel.classList.remove('dragging');
      if (rect.width < 4 || rect.height < 4) {
        rect = { x: 0, y: 0, width: 0, height: 0 };
        hint.style.display = '';
        layer.style.cursor = '';
        paint();
        return;
      }
      layer.style.cursor = cursorFor(hitTest(e.clientX, e.clientY));
      showActions();
    });
    shadow.querySelector('.ok')!.addEventListener('click', () => void finish(true));
    shadow.querySelector('.cancel')!.addEventListener('click', () => void finish(false));
    paint();
  }

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'region:select':
          startRegionSelection();
          return { ok: true };
        case 'page:prepare': {
          hideFixedEnabled = msg.hideFixed;
          scroller = findScroller();
          const doc = document.documentElement;
          saved = { x: window.scrollX, y: window.scrollY, behavior: doc.style.scrollBehavior, scrollerTop: scroller?.scrollTop ?? 0 };
          doc.style.scrollBehavior = 'auto';
          await preloadLazyContent();
          return metrics();
        }
        case 'page:metrics':
          return metrics();
        case 'page:scrollTo': {
          if (hideFixedEnabled && msg.y > 0 && hidden.length === 0) hideFixedElements();
          setProgressVisible(false);
          const actual = await scrollToY(msg.y);
          return { y: actual };
        }
        case 'page:progress':
          showProgress(msg.label, msg.progress);
          setProgressVisible(true);
          return { ok: true };
        case 'page:restore': {
          restoreFixedElements();
          removeProgress();
          if (saved) {
            document.documentElement.style.scrollBehavior = saved.behavior;
            if (scroller) scroller.scrollTop = saved.scrollerTop;
            window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' as ScrollBehavior });
          }
          saved = null;
          scroller = null;
          return { ok: true };
        }
      }
      return { ok: false };
    })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });
})();

export {};

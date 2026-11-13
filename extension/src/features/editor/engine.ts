import { Canvas, Ellipse, FabricImage, IText, Path, Rect, StaticCanvas, util, type FabricObject, type TPointerEventInfo } from 'fabric';
import { HistoryStack } from './history';
import { arrowPath, blurBlockSize, clampCrop, clampZoom } from './geometry';
import { pixelateRegion } from './pixelate';
import { normalizeRect } from '@/features/screenshot/stitch';

export type Tool = 'select' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'blur' | 'crop';

export const HIGHLIGHT_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd', '#fdba74'];
export const STROKE_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#111827', '#ffffff'];

/** Extra properties persisted with each object. */
const PROPS = ['snapType', 'lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY', 'lockRotation', 'hasControls', 'selectable', 'evented'];

export interface Snapshot {
  baseIndex: number;
  objects: object[];
  width: number;
  height: number;
}

export interface EditorDraftState {
  base: Blob;
  objects: object[];
  width: number;
  height: number;
}

export interface EngineStatus {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  selectionIsText: boolean;
  textStyle: { fontSize: number; bold: boolean; italic: boolean; background: boolean } | null;
  zoom: number;
  width: number;
  height: number;
  cropRect: { x: number; y: number; width: number; height: number } | null;
  dirty: boolean;
}

type Snapped = FabricObject & { snapType?: string };

/**
 * Fabric.js-backed editing engine. The original image is never mutated: crops create new base
 * bitmaps and every state is a snapshot so undo/redo/reset are exact.
 */
export class EditorEngine {
  readonly canvas: Canvas;
  private bases: { blob: Blob; image: HTMLImageElement }[] = [];
  private baseIndex = 0;
  private history!: HistoryStack<Snapshot>;
  private tool: Tool = 'select';
  private color = STROKE_COLORS[0];
  private highlightColor = HIGHLIGHT_COLORS[0];
  private strokeWidth = 4;
  private fontSize = 24;
  private zoom = 1;
  private drawing: { start: { x: number; y: number }; obj: FabricObject | null } | null = null;
  private cropRect: Rect | null = null;
  private restoring = false;
  private dirty = false;
  private listeners = new Set<(s: EngineStatus) => void>();
  private onChange?: () => void;

  constructor(el: HTMLCanvasElement, opts: { onChange?: () => void } = {}) {
    this.onChange = opts.onChange;
    this.canvas = new Canvas(el, { preserveObjectStacking: true, selection: true, uniformScaling: false, enableRetinaScaling: true });
    this.canvas.on('mouse:down', (e) => this.onDown(e));
    this.canvas.on('mouse:move', (e) => this.onMove(e));
    this.canvas.on('mouse:up', () => this.onUp());
    this.canvas.on('object:modified', (e) => (e.target === this.cropRect ? this.emit() : this.commit()));
    this.canvas.on('text:editing:exited', (e) => {
      const t = (e as unknown as { target: IText }).target;
      if (t && !t.text?.trim()) this.canvas.remove(t);
      this.commit();
    });
    for (const ev of ['selection:created', 'selection:updated', 'selection:cleared'] as const) this.canvas.on(ev, () => this.emit());
  }

  /* ---------------- lifecycle ---------------- */

  async load(original: Blob, draft?: EditorDraftState | null): Promise<void> {
    const base = await this.addBase(original);
    this.baseIndex = 0;
    this.setBaseImage(base.image);
    this.history = new HistoryStack<Snapshot>(this.snapshot());
    if (draft) {
      const idx = this.bases.length;
      await this.addBase(draft.base);
      await this.restore({ baseIndex: idx, objects: draft.objects, width: draft.width, height: draft.height });
      this.history.push(this.snapshot());
      this.dirty = true;
    }
    this.emit();
  }

  dispose() {
    for (const b of this.bases) URL.revokeObjectURL(b.image.src);
    this.bases = [];
    void this.canvas.dispose();
  }

  subscribe(fn: (s: EngineStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status());
    return () => this.listeners.delete(fn);
  }

  private async addBase(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    const entry = { blob, image };
    this.bases.push(entry);
    return entry;
  }

  private setBaseImage(img: HTMLImageElement) {
    const bg = new FabricImage(img, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: false, evented: false });
    this.canvas.backgroundImage = bg;
    this.applyZoom();
  }

  get imageWidth() {
    return this.bases[this.baseIndex]?.image.naturalWidth ?? 0;
  }
  get imageHeight() {
    return this.bases[this.baseIndex]?.image.naturalHeight ?? 0;
  }

  /* ---------------- status ---------------- */

  status(): EngineStatus {
    const active = this.canvas.getActiveObject();
    const text = active instanceof IText ? active : null;
    return {
      canUndo: this.history?.canUndo ?? false,
      canRedo: this.history?.canRedo ?? false,
      hasSelection: !!active,
      selectionIsText: !!text,
      textStyle: text ? { fontSize: text.fontSize ?? 24, bold: text.fontWeight === 'bold', italic: text.fontStyle === 'italic', background: !!text.backgroundColor } : null,
      zoom: this.zoom,
      width: this.imageWidth,
      height: this.imageHeight,
      cropRect: this.cropRect ? { x: this.cropRect.left!, y: this.cropRect.top!, width: this.cropRect.width! * (this.cropRect.scaleX ?? 1), height: this.cropRect.height! * (this.cropRect.scaleY ?? 1) } : null,
      dirty: this.dirty,
    };
  }

  private emit() {
    const s = this.status();
    this.listeners.forEach((l) => l(s));
  }

  markSaved() {
    this.dirty = false;
    this.emit();
  }

  /* ---------------- snapshots / history ---------------- */

  private snapshot(): Snapshot {
    const objects = this.canvas
      .getObjects()
      .filter((o) => o !== this.cropRect)
      .map((o) => o.toObject(PROPS));
    return { baseIndex: this.baseIndex, objects, width: this.imageWidth, height: this.imageHeight };
  }

  private commit() {
    if (this.restoring || !this.history) return;
    this.history.push(this.snapshot());
    this.dirty = true;
    this.emit();
    this.onChange?.();
  }

  private async restore(s: Snapshot) {
    this.restoring = true;
    try {
      this.cancelCrop(false);
      this.canvas.discardActiveObject();
      this.canvas.remove(...this.canvas.getObjects());
      this.baseIndex = s.baseIndex;
      this.setBaseImage(this.bases[s.baseIndex].image);
      const objs = (await util.enlivenObjects(s.objects)) as FabricObject[];
      for (const o of objs) this.canvas.add(o);
      this.applyToolInteractivity();
      this.canvas.requestRenderAll();
    } finally {
      this.restoring = false;
    }
  }

  async undo() {
    const s = this.history.undo();
    if (s) {
      await this.restore(s);
      this.dirty = true;
      this.emit();
      this.onChange?.();
    }
  }

  async redo() {
    const s = this.history.redo();
    if (s) {
      await this.restore(s);
      this.dirty = true;
      this.emit();
      this.onChange?.();
    }
  }

  /** Back to the untouched original (undoable). */
  async resetAll() {
    await this.restore({ baseIndex: 0, objects: [], width: this.bases[0].image.naturalWidth, height: this.bases[0].image.naturalHeight });
    this.commit();
  }

  clearAnnotations() {
    this.cancelCrop(false);
    this.canvas.discardActiveObject();
    this.canvas.remove(...this.canvas.getObjects());
    this.commit();
  }

  deleteSelected() {
    const active = this.canvas.getActiveObjects();
    if (!active.length) return;
    if (active.length === 1 && active[0] instanceof IText && (active[0] as IText).isEditing) return;
    this.canvas.discardActiveObject();
    this.canvas.remove(...active);
    this.commit();
  }

  /* ---------------- tools & styles ---------------- */

  setTool(tool: Tool) {
    if (this.tool === 'crop' && tool !== 'crop') this.cancelCrop(true);
    this.tool = tool;
    this.canvas.discardActiveObject();
    this.applyToolInteractivity();
    this.canvas.defaultCursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
    this.canvas.requestRenderAll();
    this.emit();
  }

  private applyToolInteractivity() {
    const sel = this.tool === 'select';
    this.canvas.selection = sel;
    this.canvas.forEachObject((o) => {
      if (o === this.cropRect) return;
      o.selectable = sel;
      o.evented = sel;
    });
  }

  setColor(color: string) {
    this.color = color;
    const objs = this.canvas.getActiveObjects() as Snapped[];
    if (!objs.length) return;
    for (const o of objs) {
      if (o.snapType === 'blur' || o.snapType === 'highlight') continue;
      if (o instanceof IText) o.set('fill', color);
      else o.set('stroke', color);
    }
    this.canvas.requestRenderAll();
    this.commit();
  }

  setHighlightColor(color: string) {
    this.highlightColor = color;
    const objs = (this.canvas.getActiveObjects() as Snapped[]).filter((o) => o.snapType === 'highlight');
    if (!objs.length) return;
    objs.forEach((o) => o.set('fill', color));
    this.canvas.requestRenderAll();
    this.commit();
  }

  setStrokeWidth(w: number) {
    this.strokeWidth = w;
    const objs = (this.canvas.getActiveObjects() as Snapped[]).filter((o) => ['arrow', 'rect', 'ellipse'].includes(o.snapType ?? ''));
    if (!objs.length) return;
    objs.forEach((o) => o.set('strokeWidth', w));
    this.canvas.requestRenderAll();
    this.commit();
  }

  setTextStyle(patch: Partial<{ fontSize: number; bold: boolean; italic: boolean; background: boolean }>) {
    const t = this.canvas.getActiveObject();
    if (patch.fontSize) this.fontSize = patch.fontSize;
    if (!(t instanceof IText)) return;
    if (patch.fontSize !== undefined) t.set('fontSize', patch.fontSize);
    if (patch.bold !== undefined) t.set('fontWeight', patch.bold ? 'bold' : 'normal');
    if (patch.italic !== undefined) t.set('fontStyle', patch.italic ? 'italic' : 'normal');
    if (patch.background !== undefined) t.set('backgroundColor', patch.background ? 'rgba(255,255,255,0.9)' : '');
    this.canvas.requestRenderAll();
    this.commit();
  }

  /* ---------------- zoom ---------------- */

  setZoom(z: number) {
    this.zoom = clampZoom(z);
    this.applyZoom();
    this.emit();
  }

  private applyZoom() {
    this.canvas.setDimensions({ width: Math.round(this.imageWidth * this.zoom), height: Math.round(this.imageHeight * this.zoom) });
    this.canvas.setZoom(this.zoom);
    this.canvas.requestRenderAll();
  }

  /* ---------------- drawing ---------------- */

  private onDown(e: TPointerEventInfo) {
    if (this.tool === 'select') return;
    const p = e.scenePoint;
    if (this.tool === 'crop' && this.cropRect && e.target === this.cropRect) return; // moving the crop box
    if (this.tool === 'text') {
      const t = new IText('Comment', {
        left: p.x,
        top: p.y,
        originX: 'left',
        originY: 'top',
        fill: this.color,
        fontSize: this.fontSize,
        fontFamily: 'system-ui, sans-serif',
        backgroundColor: 'rgba(255,255,255,0.9)',
        padding: 4,
      });
      (t as Snapped).snapType = 'text';
      this.canvas.add(t);
      this.canvas.setActiveObject(t);
      t.enterEditing();
      t.selectAll();
      this.setTool('select');
      this.canvas.setActiveObject(t);
      this.commit();
      return;
    }
    if (this.tool === 'crop') this.cancelCrop(false);
    this.drawing = { start: { x: p.x, y: p.y }, obj: null };
  }

  private onMove(e: TPointerEventInfo) {
    if (!this.drawing) return;
    const { start } = this.drawing;
    const p = e.scenePoint;
    const r = normalizeRect(start.x, start.y, p.x, p.y, this.imageWidth, this.imageHeight);
    let obj = this.drawing.obj;
    const common = { originX: 'left' as const, originY: 'top' as const, selectable: false, evented: false, objectCaching: false };
    switch (this.tool) {
      case 'rect':
        if (!obj) obj = new Rect({ ...common, fill: '', stroke: this.color, strokeWidth: this.strokeWidth, strokeUniform: true });
        obj.set({ left: r.x, top: r.y, width: r.width, height: r.height });
        break;
      case 'highlight':
        if (!obj) obj = new Rect({ ...common, fill: this.highlightColor, opacity: 0.45, globalCompositeOperation: 'multiply', strokeWidth: 0 });
        obj.set({ left: r.x, top: r.y, width: r.width, height: r.height });
        break;
      case 'blur':
      case 'crop':
        if (!obj) obj = new Rect({ ...common, fill: this.tool === 'crop' ? 'rgba(99,102,241,0.08)' : 'rgba(15,23,42,0.35)', stroke: '#6366f1', strokeDashArray: [6, 4], strokeWidth: 2, strokeUniform: true });
        obj.set({ left: r.x, top: r.y, width: r.width, height: r.height });
        break;
      case 'ellipse':
        if (!obj) obj = new Ellipse({ ...common, fill: '', stroke: this.color, strokeWidth: this.strokeWidth, strokeUniform: true });
        obj.set({ left: r.x, top: r.y, rx: r.width / 2, ry: r.height / 2 });
        break;
      case 'arrow':
        if (obj) this.canvas.remove(obj);
        obj = new Path(arrowPath(start.x, start.y, p.x, p.y, this.strokeWidth), { ...common, fill: '', stroke: this.color, strokeWidth: this.strokeWidth, strokeLineCap: 'round', strokeLineJoin: 'round' });
        this.canvas.add(obj);
        this.drawing.obj = obj;
        this.canvas.requestRenderAll();
        return;
    }
    if (!this.drawing.obj && obj) this.canvas.add(obj);
    this.drawing.obj = obj;
    obj?.setCoords();
    this.canvas.requestRenderAll();
  }

  private onUp() {
    const d = this.drawing;
    this.drawing = null;
    if (!d?.obj) return;
    const o = d.obj as Snapped;
    const tooSmall = (o.width ?? 0) * (o.scaleX ?? 1) < 4 && (o.height ?? 0) * (o.scaleY ?? 1) < 4;
    if (tooSmall) {
      this.canvas.remove(o);
      this.canvas.requestRenderAll();
      return;
    }
    switch (this.tool) {
      case 'blur':
        this.canvas.remove(o);
        this.addBlur(o.left!, o.top!, o.width!, o.height!);
        return;
      case 'crop':
        this.cropRect = o as Rect;
        o.set({ selectable: true, evented: true, lockRotation: true });
        o.setControlsVisibility({ mtr: false });
        this.canvas.setActiveObject(o);
        this.emit();
        return;
      default:
        o.snapType = this.tool;
        o.set({ objectCaching: true });
        this.commit();
    }
  }

  /** Adds an opaque pixelated copy of the underlying base pixels. Locked in place so it can't be moved off the secret. */
  private addBlur(x: number, y: number, w: number, h: number) {
    const r = clampCrop({ x, y, width: w, height: h }, this.imageWidth, this.imageHeight, 2);
    if (!r) return;
    const canvasEl = pixelateRegion(this.bases[this.baseIndex].image, r.x, r.y, r.width, r.height, blurBlockSize(r.width, r.height));
    const img = new FabricImage(canvasEl, {
      left: r.x,
      top: r.y,
      originX: 'left',
      originY: 'top',
      lockMovementX: true,
      lockMovementY: true,
      lockScalingX: true,
      lockScalingY: true,
      lockRotation: true,
      hasControls: false,
      selectable: false,
      evented: false,
    });
    (img as Snapped).snapType = 'blur';
    this.canvas.add(img);
    this.commit();
  }

  /* ---------------- crop ---------------- */

  cancelCrop(render = true) {
    if (this.cropRect) {
      this.canvas.remove(this.cropRect);
      this.cropRect = null;
      if (render) {
        this.canvas.requestRenderAll();
        this.emit();
      }
    }
  }

  async applyCrop() {
    const c = this.cropRect;
    if (!c) return;
    const r = clampCrop({ x: c.left!, y: c.top!, width: c.width! * (c.scaleX ?? 1), height: c.height! * (c.scaleY ?? 1) }, this.imageWidth, this.imageHeight);
    this.cancelCrop(false);
    if (!r) return;
    const src = this.bases[this.baseIndex].image;
    const cv = document.createElement('canvas');
    cv.width = r.width;
    cv.height = r.height;
    cv.getContext('2d')!.drawImage(src, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Crop failed'))), 'image/png'));
    await this.addBase(blob);
    const objects = this.canvas.getObjects().map((o) => {
      const json = o.toObject(PROPS) as { left: number; top: number };
      return { ...json, left: json.left - r.x, top: json.top - r.y };
    });
    await this.restore({ baseIndex: this.bases.length - 1, objects, width: r.width, height: r.height });
    this.setTool('select');
    this.commit();
  }

  /* ---------------- export ---------------- */

  /** Renders base + annotations at 100% into a PNG, independent of current zoom/selection. */
  async exportPng(): Promise<Blob> {
    const objects = this.canvas
      .getObjects()
      .filter((o) => o !== this.cropRect)
      .map((o) => o.toObject(PROPS));
    const el = document.createElement('canvas');
    const sc = new StaticCanvas(el, { width: this.imageWidth, height: this.imageHeight, enableRetinaScaling: false });
    sc.backgroundImage = new FabricImage(this.bases[this.baseIndex].image, { left: 0, top: 0, originX: 'left', originY: 'top' });
    const objs = (await util.enlivenObjects(objects)) as FabricObject[];
    objs.forEach((o) => sc.add(o));
    sc.renderAll();
    const out = sc.toCanvasElement(1);
    const blob = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), 'image/png'));
    void sc.dispose();
    return blob;
  }

  draftState(): EditorDraftState {
    return { base: this.bases[this.baseIndex].blob, objects: this.snapshot().objects, width: this.imageWidth, height: this.imageHeight };
  }

  get isPristine(): boolean {
    return this.baseIndex === 0 && this.canvas.getObjects().filter((o) => o !== this.cropRect).length === 0;
  }
}

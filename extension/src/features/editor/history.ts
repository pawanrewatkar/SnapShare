/** Bounded undo/redo stack of immutable snapshots. */
export class HistoryStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private current: T;

  constructor(
    initial: T,
    private limit = 100,
  ) {
    this.current = initial;
  }

  get present(): T {
    return this.current;
  }

  push(next: T): void {
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Replace everything (used when restoring a draft). */
  reset(initial: T): void {
    this.past = [];
    this.future = [];
    this.current = initial;
  }
}

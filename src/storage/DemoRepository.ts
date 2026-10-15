import { createDemoData } from '../domain/logic';
import type { DemoData, StorageAdapter } from '../domain/types';
import { CorruptDemoDataError, validateDemoData } from './validate';

type Transaction = (data: DemoData) => DemoData | Promise<DemoData>;

function freeze(data: DemoData): DemoData {
  for (const collection of [data.members, data.stamps, data.coupons, data.notices]) {
    collection.forEach(Object.freeze);
    Object.freeze(collection);
  }
  return Object.freeze(data);
}

export class DemoRepository {
  private snapshot: DemoData | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private now: () => Date;

  constructor(private readonly storage: StorageAdapter, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  getSnapshot = (): DemoData | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  load(): Promise<DemoData> {
    return this.enqueue(() => this.loadInQueue());
  }

  transact(transaction: Transaction): Promise<DemoData> {
    return this.enqueue(async () => {
      const previous = await this.loadInQueue();
      const proposed = await transaction(validateDemoData(previous));
      const next = freeze(validateDemoData(proposed));
      await this.write(next);
      this.publish(next);
      return next;
    });
  }

  reset(): Promise<DemoData> {
    return this.enqueue(async () => {
      const next = freeze(validateDemoData(createDemoData(this.now())));
      await this.write(next);
      this.publish(next);
      return next;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadInQueue(): Promise<DemoData> {
    if (this.snapshot !== null) return this.snapshot;
    let stored: DemoData | null;
    try {
      stored = await this.storage.read();
    } catch (error) {
      if (error instanceof CorruptDemoDataError || error instanceof SyntaxError) throw new CorruptDemoDataError();
      throw new Error('保存データを読み込めませんでした。データは上書きしていません。');
    }
    const next = freeze(validateDemoData(stored === null ? createDemoData(this.now()) : stored));
    if (stored === null) await this.write(next);
    this.publish(next);
    return next;
  }

  private async write(next: DemoData): Promise<void> {
    try {
      await this.storage.write(next);
    } catch {
      throw new Error('保存に失敗しました。変更は反映されていません。もう一度お試しください。');
    }
  }

  private publish(next: DemoData): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      // A display callback must not turn a successful disk write into a failed transaction.
      try { listener(); } catch { /* Keep notifying the remaining subscribers. */ }
    }
  }
}

export type EventMap = Record<string, object>;

export type EventListener<TPayload extends object> = (payload: TPayload) => void | Promise<void>;

export type AnyEventEnvelope<TEvents extends EventMap> = {
  [K in keyof TEvents & string]: {
    type: K;
    payload: TEvents[K];
    emittedAtMs: number;
  };
}[keyof TEvents & string];

export type AnyEventListener<TEvents extends EventMap> = (event: AnyEventEnvelope<TEvents>) => void | Promise<void>;

export interface Subscription {
  readonly active: boolean;
  dispose(): void;
}

interface DirectListenerEntry {
  listener: EventListener<object>;
}

interface AnyListenerEntry<TEvents extends EventMap> {
  listener: AnyEventListener<TEvents>;
}

class BasicSubscription implements Subscription {
  private _active = true;
  private readonly disposer: () => void;

  constructor(disposer: () => void) {
    this.disposer = disposer;
  }

  get active(): boolean {
    return this._active;
  }

  dispose(): void {
    if (!this._active) return;
    this._active = false;
    this.disposer();
  }
}

export class EventBusDisposedError extends Error {
  constructor() {
    super('Event bus has been disposed');
    this.name = 'EventBusDisposedError';
  }
}

export class EventBus<TEvents extends EventMap> {
  private readonly listeners = new Map<keyof TEvents & string, Set<DirectListenerEntry>>();
  private readonly anyListeners = new Set<AnyListenerEntry<TEvents>>();
  private readonly subscriptions = new Set<BasicSubscription>();
  private disposed = false;

  on<K extends keyof TEvents & string>(type: K, listener: EventListener<TEvents[K]>): Subscription {
    this.ensureActive();
    const set = this.getOrCreateSet(type);
    const entry: DirectListenerEntry = { listener: listener as EventListener<object> };
    set.add(entry);

    return this.createSubscription(() => {
      set.delete(entry);
      if (set.size === 0) this.listeners.delete(type);
    });
  }

  onAny(listener: AnyEventListener<TEvents>): Subscription {
    this.ensureActive();
    const entry: AnyListenerEntry<TEvents> = { listener };
    this.anyListeners.add(entry);

    return this.createSubscription(() => {
      this.anyListeners.delete(entry);
    });
  }

  listenerCount(type?: keyof TEvents & string): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  anyListenerCount(): number {
    return this.anyListeners.size;
  }

  async emit<K extends keyof TEvents & string>(type: K, payload: TEvents[K]): Promise<void> {
    this.ensureActive();

    const emittedAtMs = Date.now();
    const directListeners = [...(this.listeners.get(type) ?? [])];
    const anyListeners = [...this.anyListeners];
    const errors: unknown[] = [];

    for (const entry of directListeners) {
      try {
        await (entry.listener as EventListener<TEvents[K]>)(payload);
      } catch (err) {
        errors.push(err);
      }
    }

    if (anyListeners.length > 0) {
      const event = { type, payload, emittedAtMs } as AnyEventEnvelope<TEvents>;
      for (const entry of anyListeners) {
        try {
          await entry.listener(event);
        } catch (err) {
          errors.push(err);
        }
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `One or more listeners failed for event "${type}"`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of [...this.subscriptions]) {
      subscription.dispose();
    }
    this.listeners.clear();
    this.anyListeners.clear();
    this.subscriptions.clear();
  }

  private ensureActive(): void {
    if (this.disposed) throw new EventBusDisposedError();
  }

  private getOrCreateSet(type: keyof TEvents & string): Set<DirectListenerEntry> {
    const existing = this.listeners.get(type);
    if (existing) return existing;
    const created = new Set<DirectListenerEntry>();
    this.listeners.set(type, created);
    return created;
  }

  private createSubscription(disposer: () => void): Subscription {
    const subscription = new BasicSubscription(() => {
      disposer();
      this.subscriptions.delete(subscription);
    });
    this.subscriptions.add(subscription);
    return subscription;
  }
}

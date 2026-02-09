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
  private readonly listeners = new Map<keyof TEvents & string, Set<EventListener<object>>>();
  private readonly anyListeners = new Set<AnyEventListener<TEvents>>();
  private disposed = false;

  on<K extends keyof TEvents & string>(type: K, listener: EventListener<TEvents[K]>): Subscription {
    this.ensureActive();
    const set = this.getOrCreateSet(type);
    set.add(listener as EventListener<object>);

    return new BasicSubscription(() => {
      set.delete(listener as EventListener<object>);
      if (set.size === 0) this.listeners.delete(type);
    });
  }

  onAny(listener: AnyEventListener<TEvents>): Subscription {
    this.ensureActive();
    this.anyListeners.add(listener);
    return new BasicSubscription(() => {
      this.anyListeners.delete(listener);
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
    const directListeners = [...(this.listeners.get(type) ?? [])] as Array<EventListener<TEvents[K]>>;
    const anyListeners = [...this.anyListeners];
    const errors: unknown[] = [];

    for (const listener of directListeners) {
      try {
        await listener(payload);
      } catch (err) {
        errors.push(err);
      }
    }

    if (anyListeners.length > 0) {
      const event = { type, payload, emittedAtMs } as AnyEventEnvelope<TEvents>;
      for (const listener of anyListeners) {
        try {
          await listener(event);
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
    this.listeners.clear();
    this.anyListeners.clear();
  }

  private ensureActive(): void {
    if (this.disposed) throw new EventBusDisposedError();
  }

  private getOrCreateSet(type: keyof TEvents & string): Set<EventListener<object>> {
    const existing = this.listeners.get(type);
    if (existing) return existing;
    const created = new Set<EventListener<object>>();
    this.listeners.set(type, created);
    return created;
  }
}

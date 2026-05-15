import type { AgentEvent } from "../adapter";

const TIMEOUT = Symbol("timeout");

type PendingNext = Promise<IteratorResult<AgentEvent>>;

function timeout(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
}

export class AgentEventCollector {
  private pending?: PendingNext;

  constructor(private readonly iterator: AsyncIterator<AgentEvent>) {}

  private next(): PendingNext {
    this.pending ??= this.iterator.next();
    return this.pending;
  }

  async collectUntilQuiet(input: {
    quietMs: number;
    maxMs?: number;
  }): Promise<AgentEvent[]> {
    const quietMs = input.quietMs;
    const maxMs = input.maxMs ?? Math.max(quietMs * 6, quietMs);
    const events: AgentEvent[] = [];
    const hardDeadline = Date.now() + maxMs;
    let quietDeadline = Date.now() + quietMs;

    while (Date.now() < hardDeadline) {
      const waitMs = Math.max(
        0,
        Math.min(quietDeadline, hardDeadline) - Date.now(),
      );
      if (waitMs === 0) break;

      const result = await Promise.race([this.next(), timeout(waitMs)]);
      if (result === TIMEOUT) break;

      this.pending = undefined;
      if (result.done) break;

      events.push(result.value);
      quietDeadline = Date.now() + quietMs;
    }

    return events;
  }
}

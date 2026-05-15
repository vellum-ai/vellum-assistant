import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import { AgentEventCollector } from "../runner/event-collector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("AgentEventCollector", () => {
  test("does not drop an event when a quiet timeout wins before next resolves", async () => {
    const first = deferred<IteratorResult<AgentEvent>>();
    const second = deferred<IteratorResult<AgentEvent>>();
    const iterator: AsyncIterator<AgentEvent> = {
      next: (() => {
        const calls = [first.promise, second.promise];
        return () =>
          calls.shift() ?? Promise.resolve({ done: true, value: undefined });
      })(),
    };
    const collector = new AgentEventCollector(iterator);

    const empty = await collector.collectUntilQuiet({ quietMs: 1, maxMs: 1 });
    expect(empty).toEqual([]);

    first.resolve({
      done: false,
      value: { message: { type: "text", text: "late" } },
    });
    const late = await collector.collectUntilQuiet({ quietMs: 10, maxMs: 20 });

    expect(late).toEqual([{ message: { type: "text", text: "late" } }]);
  });
});

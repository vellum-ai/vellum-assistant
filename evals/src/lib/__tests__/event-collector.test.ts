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

function textEvent(text: string): AgentEvent {
  return { message: { type: "assistant_text_delta", text } };
}

function arrayIterator(events: AgentEvent[]): AsyncIterator<AgentEvent> {
  const queue = events.slice();
  return {
    async next(): Promise<IteratorResult<AgentEvent>> {
      if (queue.length === 0) return { done: true, value: undefined };
      return { done: false, value: queue.shift()! };
    },
  };
}

function joinText(events: readonly AgentEvent[]): string {
  return events.map((e) => e.message.text ?? "").join("");
}

describe("AgentEventCollector.collectUntilSentinel", () => {
  test("reports sentinelSeen and still drains events that trail the sentinel", async () => {
    // GIVEN a stream where the sentinel is followed by a trailing event
    // (e.g. the assistant_usage event the daemon emits after the turn's
    // final text)
    const collector = new AgentEventCollector(
      arrayIterator([
        textEvent("reading"),
        textEvent(" files"),
        textEvent("\nReady."),
        { message: { type: "assistant_usage", input_tokens: 10 } },
      ]),
    );

    // WHEN we collect until the assistant text contains "Ready."
    const { events, sentinelSeen } = await collector.collectUntilSentinel({
      isDone: (evts) => joinText(evts).includes("Ready."),
      maxMs: 1_000,
      quietMs: 1_000,
    });

    // THEN the sentinel is reported AND the trailing usage event is still
    // captured (we do not cut the turn off the instant the sentinel lands)
    expect(sentinelSeen).toBe(true);
    expect(events.length).toBe(4);
    expect(events[3]?.message.type).toBe("assistant_usage");
  });

  test("reports sentinelSeen=false when the stream ends without the sentinel", async () => {
    // GIVEN a stream that ends without ever emitting the sentinel
    const collector = new AgentEventCollector(
      arrayIterator([textEvent("working"), textEvent(" hard")]),
    );

    // WHEN we collect until a sentinel that never arrives
    const { events, sentinelSeen } = await collector.collectUntilSentinel({
      isDone: (evts) => joinText(evts).includes("Ready."),
      maxMs: 1_000,
      quietMs: 1_000,
    });

    // THEN it drains the stream and signals the sentinel was not seen
    expect(sentinelSeen).toBe(false);
    expect(events.length).toBe(2);
  });

  test("reports sentinelSeen=false when a stalled stream goes quiet", async () => {
    // GIVEN a stream that emits one event then hangs indefinitely
    const blocked = deferred<IteratorResult<AgentEvent>>();
    const iterator: AsyncIterator<AgentEvent> = {
      next: (() => {
        const calls = [
          Promise.resolve<IteratorResult<AgentEvent>>({
            done: false,
            value: textEvent("partial"),
          }),
        ];
        return () => calls.shift() ?? blocked.promise;
      })(),
    };
    const collector = new AgentEventCollector(iterator);

    // WHEN the sentinel never arrives and the stream goes quiet
    const { events, sentinelSeen } = await collector.collectUntilSentinel({
      isDone: (evts) => joinText(evts).includes("Ready."),
      maxMs: 1_000,
      quietMs: 5,
    });

    // THEN the quiet guard returns without the sentinel rather than hanging
    expect(sentinelSeen).toBe(false);
    expect(events.length).toBe(1);
  });
});

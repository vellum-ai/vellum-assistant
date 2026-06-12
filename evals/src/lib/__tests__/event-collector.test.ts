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

  test("invokes onEvent for each event before reporting the sentinel", async () => {
    // GIVEN a stream carrying a confirmation_request ahead of the sentinel
    const collector = new AgentEventCollector(
      arrayIterator([
        textEvent("reading"),
        {
          message: { type: "confirmation_request", requestId: "req-1" },
        },
        textEvent("\nReady."),
      ]),
    );
    const seen: string[] = [];

    // WHEN we collect with an onEvent hook
    const { events, sentinelSeen } = await collector.collectUntilSentinel({
      isDone: (evts) => joinText(evts).includes("Ready."),
      maxMs: 1_000,
      quietMs: 1_000,
      onEvent: (event) => {
        seen.push(event.message.type);
      },
    });

    // THEN every event was observed in order AND the sentinel still reports
    expect(seen).toEqual([
      "assistant_text_delta",
      "confirmation_request",
      "assistant_text_delta",
    ]);
    expect(sentinelSeen).toBe(true);
    expect(events.length).toBe(3);
  });

  test("awaits an async onEvent before draining the next event", async () => {
    // GIVEN an onEvent hook that resolves asynchronously
    const collector = new AgentEventCollector(
      arrayIterator([
        { message: { type: "confirmation_request", requestId: "req-1" } },
        textEvent("\nReady."),
      ]),
    );
    let confirmResolved = false;
    let confirmResolvedBeforeNextEvent: boolean | undefined;

    // WHEN the hook reacts to the confirmation_request asynchronously
    await collector.collectUntilSentinel({
      isDone: (evts) => joinText(evts).includes("Ready."),
      maxMs: 1_000,
      quietMs: 1_000,
      onEvent: async (event) => {
        if (event.message.type === "confirmation_request") {
          await Promise.resolve();
          confirmResolved = true;
        } else if (confirmResolvedBeforeNextEvent === undefined) {
          confirmResolvedBeforeNextEvent = confirmResolved;
        }
      },
    });

    // THEN the async hook completed before the following event was processed
    expect(confirmResolvedBeforeNextEvent).toBe(true);
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

describe("AgentEventCollector.collectUntilTurnComplete", () => {
  test("completes on the turn-completion signal and drains trailing events", async () => {
    // GIVEN a stream where message_complete is followed by a trailing
    // usage event (the daemon emits usage after the turn's final text)
    const collector = new AgentEventCollector(
      arrayIterator([
        textEvent("hello"),
        { message: { type: "message_complete" } },
        { message: { type: "assistant_usage", input_tokens: 10 } },
      ]),
    );

    // WHEN we collect until the completion signal
    const { events, completed } = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 1_000,
      graceQuietMs: 5,
    });

    // THEN completion is reported AND the trailing usage event is still
    // captured by the grace drain
    expect(completed).toBe(true);
    expect(events.length).toBe(3);
    expect(events[2]?.message.type).toBe("assistant_usage");
  });

  test("reports completed=false when the stream ends without the signal", async () => {
    // GIVEN a stream that ends without ever emitting message_complete
    const collector = new AgentEventCollector(
      arrayIterator([textEvent("working"), textEvent(" hard")]),
    );

    // WHEN we collect until a completion signal that never arrives
    const { events, completed } = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 1_000,
      graceQuietMs: 5,
    });

    // THEN it drains the stream and signals the turn never completed
    expect(completed).toBe(false);
    expect(events.length).toBe(2);
  });

  test("waits through stream silence and only gives up at the hard deadline", async () => {
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
    const startedAt = Date.now();

    // WHEN the completion signal never arrives
    const { events, completed } = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 50,
      graceQuietMs: 5,
    });

    // THEN the wait runs to the hard deadline (no quiet-window early
    // exit) and reports the turn as incomplete
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(completed).toBe(false);
    expect(events.length).toBe(1);
  });

  test("does not drop an event when the deadline wins before next resolves", async () => {
    // GIVEN a pending next() that resolves only after a deadline-bounded
    // collection gave up
    const first = deferred<IteratorResult<AgentEvent>>();
    const iterator: AsyncIterator<AgentEvent> = {
      next: (() => {
        const calls = [first.promise];
        return () =>
          calls.shift() ?? Promise.resolve({ done: true, value: undefined });
      })(),
    };
    const collector = new AgentEventCollector(iterator);

    // WHEN the first collection times out before the event lands
    const empty = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 1,
      graceQuietMs: 1,
    });
    expect(empty.events).toEqual([]);

    // AND the event then resolves and a second collection runs
    first.resolve({ done: false, value: textEvent("late") });
    const late = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 100,
      graceQuietMs: 5,
    });

    // THEN the late event is delivered to the second collection
    expect(late.events).toEqual([textEvent("late")]);
  });

  test("invokes onEvent for events before and after the completion signal", async () => {
    // GIVEN a stream with a confirmation_request before the signal and
    // a usage event after it
    const collector = new AgentEventCollector(
      arrayIterator([
        { message: { type: "confirmation_request", requestId: "req-1" } },
        { message: { type: "message_complete" } },
        { message: { type: "assistant_usage", input_tokens: 10 } },
      ]),
    );
    const seen: string[] = [];

    // WHEN we collect with an onEvent hook
    const { completed } = await collector.collectUntilTurnComplete({
      isComplete: (event) => event.message.type === "message_complete",
      maxMs: 1_000,
      graceQuietMs: 5,
      onEvent: (event) => {
        seen.push(event.message.type);
      },
    });

    // THEN every event was observed in order, including the trailer
    expect(completed).toBe(true);
    expect(seen).toEqual([
      "confirmation_request",
      "message_complete",
      "assistant_usage",
    ]);
  });
});

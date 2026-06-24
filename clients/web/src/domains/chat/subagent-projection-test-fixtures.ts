/**
 * Shared test fixtures for the two incremental subagent projector test files
 * (`subagent-step-projection.test.ts` and `subagent-detail-projection.test.ts`).
 *
 * Both files drive their projector with the SAME deterministic store-mutation
 * stream — a seedable LCG event generator plus an append/coalesce simulator that
 * mirrors `subagent-store.receiveEvent`'s two incremental array shapes — so the
 * generator lives here ONCE to keep the two suites in lockstep.
 *
 * The ONE genuine divergence between the two suites is parameterized: when an
 * `error` event closes an in-flight tool, the detail suite attaches the tool's
 * `toolName` / `toolUseId` / `isError` / `result` metadata (so the failed-tool
 * payload is keyed and carries the error), while the step suite emits a bare
 * error row. Pass `errorEventsCarryToolMeta` to `generateStream` to select.
 */

import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

export const NOW = 1700000000000;

/** Numerical Recipes LCG — deterministic, seedable; no `Math.random`. */
export function makeRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Event factory. Each test file supplies its own `nextEventId` so the two
// suites keep independent, file-local id sequences (`te-*` vs `de-*`).
// ---------------------------------------------------------------------------

/**
 * Build a `makeEvent(overrides, ts?)` factory backed by `nextEventId`. Each test
 * file calls this once with its own id generator so ids don't collide or couple
 * across suites.
 */
export function createMakeEvent(
  nextEventId: () => string,
): (
  overrides: Partial<SubagentTimelineEvent> & {
    type: SubagentTimelineEvent["type"];
  },
  ts?: number,
) => SubagentTimelineEvent {
  return (overrides, ts = NOW) => ({
    id: nextEventId(),
    content: "",
    timestamp: ts,
    ...overrides,
  });
}

type MakeEvent = ReturnType<typeof createMakeEvent>;

// ---------------------------------------------------------------------------
// Store-mutation simulator — mirrors `subagent-store.receiveEvent`'s two
// incremental array shapes so the projector is fed precisely what it sees live.
// ---------------------------------------------------------------------------

/**
 * Append a fresh event to the events array, returning a NEW array (every prior
 * element shared by reference). Models the store's "Append-1" shape.
 */
export function appendEvent(
  events: SubagentTimelineEvent[],
  event: SubagentTimelineEvent,
): SubagentTimelineEvent[] {
  return [...events, event];
}

/**
 * Grow the trailing text event's content by `delta`, returning a NEW array with
 * only the last element replaced (same `id`, longer `content`) — the store's
 * "Mutate-last" text-coalescing shape. Falls back to appending a fresh text
 * event when the tail isn't text (matching `receiveEvent`).
 */
export function coalesceText(
  events: SubagentTimelineEvent[],
  delta: string,
  ts: number,
  makeEvent: MakeEvent,
): SubagentTimelineEvent[] {
  const last = events[events.length - 1];
  if (last && last.type === "text") {
    const updated = [...events];
    updated[updated.length - 1] = {
      ...last,
      content: last.content + delta,
    };
    return updated;
  }
  return appendEvent(events, makeEvent({ type: "text", content: delta }, ts));
}

// ---------------------------------------------------------------------------
// Deterministic event-stream generator (tiny LCG; no Math.random).
// ---------------------------------------------------------------------------

export type Mutation =
  | { kind: "append"; event: SubagentTimelineEvent }
  | { kind: "coalesce"; delta: string };

export interface GenerateStreamOptions {
  /**
   * When an `error` event closes an in-flight tool, attach the tool's
   * `toolName` / `toolUseId` / `isError` / `result` metadata. The detail suite
   * needs this so the failed-tool payload is keyed by `toolUseId` and carries
   * the error; the step suite emits a bare error row instead. Defaults to
   * `false`.
   */
  errorEventsCarryToolMeta?: boolean;
}

/**
 * Generate a deterministic sequence of store mutations: text deltas (coalesced
 * when consecutive), tool calls, their results/errors, and web_search/web_fetch
 * — covering every reducer branch. Tracks open tool ids so results/errors close
 * real in-flight calls.
 */
export function generateStream(
  seed: number,
  n: number,
  makeEvent: MakeEvent,
  { errorEventsCarryToolMeta = false }: GenerateStreamOptions = {},
): Mutation[] {
  const rng = makeRng(seed);
  const mutations: Mutation[] = [];
  const openTools: Array<{ id: string; toolName: string }> = [];
  let lastWasText = false;
  let ts = NOW;

  for (let i = 0; i < n; i++) {
    ts += 1 + Math.floor(rng() * 50);
    const roll = rng();

    // Bias toward text + appends so coalescing fires often.
    if (roll < 0.45) {
      const delta = "w".repeat(1 + Math.floor(rng() * 40));
      if (lastWasText) {
        mutations.push({ kind: "coalesce", delta });
      } else {
        mutations.push({ kind: "append", event: makeEvent({ type: "text", content: delta }, ts) });
        lastWasText = true;
      }
      continue;
    }

    lastWasText = false;

    if (roll < 0.7) {
      // Open a tool call (regular / web_search / web_fetch).
      const toolRoll = rng();
      const id = `t-${seed}-${i}`;
      if (toolRoll < 0.2) {
        mutations.push({
          kind: "append",
          event: makeEvent({ type: "tool_call", toolName: "web_search", toolUseId: id, input: { query: `q${i}` } }, ts),
        });
        openTools.push({ id, toolName: "web_search" });
      } else if (toolRoll < 0.35) {
        // web_fetch has no follow-up — a thinking step, no open tracking.
        mutations.push({
          kind: "append",
          event: makeEvent({ type: "tool_call", toolName: "web_fetch", toolUseId: id, input: { url: `https://ex${i}.dev` } }, ts),
        });
      } else {
        const toolName = toolRoll < 0.6 ? "bash" : "str_replace_editor";
        mutations.push({
          kind: "append",
          event: makeEvent({ type: "tool_call", toolName, toolUseId: id, content: `cmd-${i}` }, ts),
        });
        openTools.push({ id, toolName });
      }
      continue;
    }

    if (roll < 0.9 && openTools.length > 0) {
      // Close an open tool with a result (maybe an error result).
      const idx = Math.floor(rng() * openTools.length);
      const open = openTools.splice(idx, 1)[0]!;
      const isError = rng() < 0.25;
      mutations.push({
        kind: "append",
        event: makeEvent(
          {
            type: "tool_result",
            toolName: open.toolName,
            toolUseId: open.id,
            isError,
            result: isError ? "boom" : `result-${i}`,
            content: `result-${i}`,
          },
          ts,
        ),
      });
      continue;
    }

    if (openTools.length > 0) {
      // Close an open tool with a raw error event. The detail suite keys the
      // failed-tool payload off the closed tool's metadata; the step suite
      // emits a bare error row.
      const idx = Math.floor(rng() * openTools.length);
      const open = openTools.splice(idx, 1)[0]!;
      mutations.push({
        kind: "append",
        event: errorEventsCarryToolMeta
          ? makeEvent({ type: "error", toolName: open.toolName, toolUseId: open.id, isError: true, result: `err-${i}`, content: `err-${i}` }, ts)
          : makeEvent({ type: "error", content: `err-${i}` }, ts),
      });
      continue;
    }

    // Nothing open — emit a standalone error row.
    mutations.push({
      kind: "append",
      event: makeEvent({ type: "error", content: `err-${i}` }, ts),
    });
  }

  return mutations;
}

/** Apply one generated mutation to the events array (append or text coalesce). */
export function applyMutation(
  events: SubagentTimelineEvent[],
  m: Mutation,
  makeEvent: MakeEvent,
): SubagentTimelineEvent[] {
  return m.kind === "append"
    ? appendEvent(events, m.event)
    : coalesceText(events, m.delta, NOW, makeEvent);
}

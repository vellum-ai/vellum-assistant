/**
 * Sub-span instrumentation for the "Memory & context retrieval" latency
 * phase.
 *
 * The phase is the span of the USER_PROMPT_SUBMIT hook chain, but the work
 * inside it — graph memory retrieval, runtime injectors, memory-v3 lane
 * search and selection — happens layers below the orchestrator that owns
 * the {@link TurnLatencyTracker}. Rather than threading the tracker through
 * the hook/injector/plugin contracts, the orchestrator opens an
 * {@link AsyncLocalStorage} scope around the hook chain and instrumented
 * call sites record into it. The store propagates across `await`
 * boundaries (including `Promise.all` fan-outs); when no scope is active —
 * overflow re-injection, compaction re-assembly, `composeInjectorChain`,
 * tests — every helper is a pass-through no-op, so out-of-turn callers
 * need no guards.
 *
 * Sub-spans are leaf measurements chosen to be non-overlapping, so the
 * inspector can render an honest "Other" remainder against the phase
 * total. Never wrap a call whose interior records its own sub-spans.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { TurnLatencyTracker } from "./turn-latency-tracker.js";

/**
 * Spans shorter than this are dropped: they add blob and UI noise without
 * diagnostic value, and the inspector's "Other" remainder row absorbs
 * them. The inspector's own remainder threshold mirrors this value.
 */
export const MIN_SUB_SPAN_MS = 10;

interface SubSpanScope {
  tracker: TurnLatencyTracker;
  /** Phase key the recorded sub-spans attach to (e.g. `memory_context`). */
  parentKey: string;
}

const storage = new AsyncLocalStorage<SubSpanScope>();

/**
 * Run `fn` with sub-span recording bound to `tracker` under `parentKey`.
 * The returned value (including a promise) carries the scope across its
 * async continuations.
 */
export function runWithLatencySubSpans<T>(
  tracker: TurnLatencyTracker,
  parentKey: string,
  fn: () => T,
): T {
  return storage.run({ tracker, parentKey }, fn);
}

/**
 * Record an already-measured sub-span. No-op when no scope is active or
 * the duration is under {@link MIN_SUB_SPAN_MS}.
 */
export function recordLatencySubSpan(
  key: string,
  label: string,
  ms: number,
): void {
  const scope = storage.getStore();
  if (!scope || ms < MIN_SUB_SPAN_MS) return;
  scope.tracker.recordSubSpan(scope.parentKey, key, label, ms);
}

/**
 * Measure `fn` as a sub-span. Outside a scope this is a plain call with no
 * clock reads. The span records in `finally`, so a throwing stage still
 * reports the time it spent.
 */
export async function timeLatencySubSpan<T>(
  key: string,
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (storage.getStore() === undefined) {
    return await fn();
  }
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordLatencySubSpan(key, label, Date.now() - startedAt);
  }
}

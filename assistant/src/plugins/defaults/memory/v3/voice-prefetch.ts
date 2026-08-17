/**
 * Request-scoped memory-v3 preparation for the live-voice front door.
 *
 * The front-door model must start without waiting for dense retrieval and the
 * selector LLM. Its prompt hook starts one prepared result here and continues
 * with carried memory only. If the front model escalates, the immediately
 * following call-agent turn consumes and commits the prepared result. Direct
 * answers, hold verdicts, and abandoned calls cancel it without committing
 * selection rows or ever-injected state.
 */

import { runWithoutLatencySubSpans } from "../../../../daemon/turn-latency-sub-spans.js";
import type { OrchestrateResult } from "./orchestrate.js";
import {
  commitPreparedMemoryV3Turn,
  prepareMemoryV3Turn,
} from "./shadow-plugin.js";

const PREFETCH_TTL_MS = 60_000;
const MAX_PREFETCHED_CONVERSATIONS = 256;

interface PrefetchOutcome {
  result: OrchestrateResult | null;
  error?: unknown;
}

interface VoicePrefetchEntry {
  sourceTurnIndex: number;
  controller: AbortController;
  promise: Promise<PrefetchOutcome>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, VoicePrefetchEntry>();

function cancelEntry(conversationId: string, entry: VoicePrefetchEntry): void {
  if (entries.get(conversationId) === entry) {
    entries.delete(conversationId);
  }
  clearTimeout(entry.expiryTimer);
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(new Error("voice memory prefetch cancelled"));
  }
}

function evictOldestEntry(): void {
  if (entries.size < MAX_PREFETCHED_CONVERSATIONS) {
    return;
  }
  const oldest = entries.entries().next().value as
    | [string, VoicePrefetchEntry]
    | undefined;
  if (oldest) {
    cancelEntry(oldest[0], oldest[1]);
  }
}

/** Start full v3 preparation without awaiting it or charging it to hook time. */
export function startVoiceMemoryV3Prefetch(
  conversationId: string,
  sourceTurnIndex: number,
): void {
  const existing = entries.get(conversationId);
  if (existing?.sourceTurnIndex === sourceTurnIndex) {
    return;
  }
  if (existing) {
    cancelEntry(conversationId, existing);
  }
  evictOldestEntry();

  const controller = new AbortController();
  const promise = runWithoutLatencySubSpans(
    async (): Promise<PrefetchOutcome> => {
      try {
        const result = await prepareMemoryV3Turn(
          conversationId,
          sourceTurnIndex,
          controller.signal,
        );
        return { result };
      } catch (error) {
        return { result: null, error };
      }
    },
  );
  const expiryTimer = setTimeout(() => {
    const current = entries.get(conversationId);
    if (current?.sourceTurnIndex === sourceTurnIndex) {
      cancelEntry(conversationId, current);
    }
  }, PREFETCH_TTL_MS);
  expiryTimer.unref?.();

  entries.set(conversationId, {
    sourceTurnIndex,
    controller,
    promise,
    expiryTimer,
  });
}

/** Cancel an unused front-door preparation. Idempotent. */
export function cancelVoiceMemoryV3Prefetch(conversationId: string): void {
  const entry = entries.get(conversationId);
  if (entry) {
    cancelEntry(conversationId, entry);
  }
}

/**
 * Take the front turn's prepared result for the immediately following
 * escalated turn. Returns `null` when no matching preparation exists, letting
 * the ordinary per-turn retrieval path run unchanged.
 */
export function takeVoiceMemoryV3Prefetch(
  conversationId: string,
  consumerTurnIndex: number,
  consumerSignal?: AbortSignal,
): Promise<OrchestrateResult | null> | null {
  const entry = entries.get(conversationId);
  if (!entry) {
    return null;
  }
  if (consumerTurnIndex !== entry.sourceTurnIndex + 1) {
    if (consumerTurnIndex > entry.sourceTurnIndex + 1) {
      cancelEntry(conversationId, entry);
    }
    return null;
  }

  entries.delete(conversationId);
  clearTimeout(entry.expiryTimer);
  return (async () => {
    let settleAbort: () => void = () => {};
    const aborted = new Promise<null>((resolve) => {
      settleAbort = () => resolve(null);
    });
    const abortPreparation = (): void => {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(consumerSignal?.reason);
      }
      settleAbort();
    };

    if (consumerSignal?.aborted) {
      abortPreparation();
    } else {
      consumerSignal?.addEventListener("abort", abortPreparation, {
        once: true,
      });
    }

    try {
      const outcome = consumerSignal
        ? await Promise.race([entry.promise, aborted])
        : await entry.promise;
      if (outcome === null || consumerSignal?.aborted) {
        return null;
      }
      if (outcome.error !== undefined) {
        throw outcome.error;
      }
      if (outcome.result) {
        commitPreparedMemoryV3Turn(
          conversationId,
          consumerTurnIndex,
          outcome.result,
        );
      }
      return outcome.result;
    } finally {
      consumerSignal?.removeEventListener("abort", abortPreparation);
    }
  })();
}

/** Test-only reset for process-global prefetch state. */
export function resetVoiceMemoryV3PrefetchForTests(): void {
  for (const [conversationId, entry] of entries) {
    cancelEntry(conversationId, entry);
  }
  entries.clear();
}

/** Test-only visibility into whether a conversation owns a pending result. */
export function hasVoiceMemoryV3PrefetchForTests(
  conversationId: string,
): boolean {
  return entries.has(conversationId);
}

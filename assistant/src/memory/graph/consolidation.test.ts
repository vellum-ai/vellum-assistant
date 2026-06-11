// ---------------------------------------------------------------------------
// consolidation.test.ts — timeout-handling coverage for `runConsolidation`.
//
// Two distinct timeout contracts are exercised:
//
//   1. Dupe-scan degradation (`identifyDuplicateGroups`): provider unavailable
//      returns []. The M3 timeout wraps `sendMessage`, so a 60s abort
//      (DOMException AbortError) must also degrade to "no dupes found" rather
//      than propagating out and abandoning the whole consolidation partition.
//      The first test proves the partition survives the dupe-scan failure and
//      still runs the singleton fidelity/narrative pass.
//
//   2. Chunk-consolidation re-throw (round-3 review follow-up): a chunk-level
//      timeout (`consolidateChunk`) is a backend OUTAGE that affects every
//      partition, not a single bad partition. `consolidateChunk` translates the
//      abort to `BackendUnavailableError`, and `runConsolidation`'s per-partition
//      catch must RE-THROW it (not degrade to a zero-result partition) so the
//      job worker can defer/retry instead of silently completing the job. The
//      second test proves the error propagates out of `runConsolidation`.
//
// Only the provider boundary is mocked; SQLite/store run unmocked against the
// in-process test DB so the assertions reflect real graph state.
// ---------------------------------------------------------------------------

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "../../providers/types.js";

// Provider stub — each test sets `providerStub`; `null` simulates "no provider".
let providerStub: Provider | null = null;
// Tool names the stub was asked to produce, in call order. Lets a test assert
// the singleton consolidation pass ran AFTER the dupe-scan call aborted.
let toolCalls: string[] = [];

// `runConsolidation` imports `getConfiguredProvider`, `userMessage`,
// `extractToolUse`, and `createTimeout` from this module — the mock must export
// all four. `createTimeout` keeps its real shape (real abort timer) so the
// finally-cleanup path is exercised; the timeout itself is simulated by having
// `sendMessage` reject for the dupe-scan call.
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
  // Cap the fuse at 100ms so the chunk-timeout test aborts quickly instead of
  // waiting the real 120s `CONSOLIDATE_CHUNK_TIMEOUT_MS`. The dupe-scan and
  // empty-diff stubs resolve/throw synchronously on the next microtask, well
  // before 100ms, so the cap never trips them.
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(ms, 100));
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  },
}));

import { resetDbForTesting } from "../../__tests__/db-test-helpers.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { BackendUnavailableError } from "../../util/errors.js";
import { initializeDb } from "../db-init.js";
import { runConsolidation } from "./consolidation.js";
import { createNode } from "./store.js";
import type { NewNode } from "./types.js";

const SCOPE = "consolidation-timeout-test";

/** Build a recent narrative node so it lands in the "recent" partition. */
function makeNode(content: string): NewNode {
  const now = Date.now();
  return {
    content,
    type: "narrative",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.3,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.3,
    },
    fidelity: "clear",
    confidence: 0.7,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [],
    sourceType: "observed",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: SCOPE,
  };
}

function seedNodes(count: number): void {
  for (let i = 0; i < count; i++) {
    createNode(
      makeNode(`Distinct memory ${i}: an unrelated fact about topic ${i}.`),
    );
  }
}

/**
 * Provider stub that aborts the dupe-scan call and succeeds (empty diff) on the
 * chunk-consolidation call. Branches on the forced `tool_choice.name`.
 */
function makeTimeoutOnDupeScanProvider(): Provider {
  return {
    name: "stub",
    sendMessage: async (
      _msgs: Message[],
      opts?: SendMessageOptions,
    ): Promise<ProviderResponse> => {
      // `tool_choice` lives under SendMessageConfig's index signature, so it
      // reads back as `unknown`; narrow it to pull the forced tool name.
      const choice = opts?.config?.tool_choice;
      const toolName =
        choice != null &&
        typeof choice === "object" &&
        "name" in choice &&
        typeof (choice as { name?: unknown }).name === "string"
          ? (choice as { name: string }).name
          : "<auto>";
      toolCalls.push(toolName);

      if (toolName === "report_duplicate_groups") {
        // Simulate the 60s timeout firing: an aborted request rejects with a
        // DOMException AbortError. `identifyDuplicateGroups` must catch this and
        // degrade to [] rather than letting it crash the partition.
        const err = new DOMException(
          "The operation was aborted.",
          "AbortError",
        );
        throw err;
      }

      // consolidate_diff: return a well-formed empty diff (no-op). Reaching this
      // call proves the partition continued past the dupe-scan abort into the
      // singleton consolidation pass.
      return {
        model: "stub-model",
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "consolidate_diff",
            input: { updates: [], delete_ids: [], merge_edges: [] },
          },
        ],
      };
    },
  } as Provider;
}

/**
 * Provider stub where the dupe-scan call returns "no dupes" (so the partition
 * proceeds to the singleton consolidation pass) and the chunk-consolidation call
 * stalls until its abort signal fires — simulating a chunk-level timeout. The
 * resulting `BackendUnavailableError` from `consolidateChunk` must propagate out
 * of `runConsolidation`'s per-partition catch (not degrade to a zero-result
 * partition), so the job worker can defer/retry the whole consolidation.
 */
function makeTimeoutOnConsolidateChunkProvider(): Provider {
  return {
    name: "stub",
    sendMessage: (
      _msgs: Message[],
      opts?: SendMessageOptions,
    ): Promise<ProviderResponse> => {
      const choice = opts?.config?.tool_choice;
      const toolName =
        choice != null &&
        typeof choice === "object" &&
        "name" in choice &&
        typeof (choice as { name?: unknown }).name === "string"
          ? (choice as { name: string }).name
          : "<auto>";
      toolCalls.push(toolName);

      if (toolName === "report_duplicate_groups") {
        // No dupes — lets the partition advance to the singleton chunk pass.
        return Promise.resolve({
          model: "stub-model",
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          content: [
            {
              type: "tool_use",
              id: "tu-dupe",
              name: "report_duplicate_groups",
              input: { groups: [] },
            },
          ],
        });
      }

      // consolidate_diff: stall until the timeout aborts the signal, then reject
      // with an AbortError. `consolidateChunk` sees `signal.aborted` and throws
      // `BackendUnavailableError`, which the partition catch must re-throw.
      return new Promise<ProviderResponse>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
  } as Provider;
}

describe("runConsolidation — dupe-scan timeout degradation", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    resetDbForTesting();
    initializeDb();
    providerStub = null;
    toolCalls = [];
  });

  test("a dupe-scan timeout degrades to [] and the partition still runs the singleton pass", async () => {
    // Need ≥2 nodes so the dupe-scan runs, and enough singletons so the
    // singleton consolidation pass (chunked at ≥2) is reached.
    seedNodes(4);
    providerStub = makeTimeoutOnDupeScanProvider();

    // Must NOT throw — a transient dupe-scan timeout degrades to "no dupes",
    // letting the partition continue rather than crashing the consolidation.
    const result = await runConsolidation(SCOPE, DEFAULT_CONFIG);

    // The dupe-scan call was attempted (and aborted).
    expect(toolCalls).toContain("report_duplicate_groups");
    // The singleton consolidation pass ran AFTER the dupe-scan abort — proving
    // graceful degradation rather than partition abandonment.
    expect(toolCalls).toContain("consolidate_diff");
    // No nodes were lost; the empty diff is a no-op.
    expect(result.totalDeleted).toBe(0);
  });

  test("a chunk-consolidation timeout re-throws BackendUnavailableError so the job worker defers/retries", async () => {
    // ≥2 nodes so the singleton consolidation chunk pass runs and can time out.
    seedNodes(4);
    providerStub = makeTimeoutOnConsolidateChunkProvider();

    // The chunk timeout surfaces as `BackendUnavailableError` from
    // `consolidateChunk`. A backend outage affects every partition, so the
    // per-partition catch must RE-THROW it rather than degrading to a
    // zero-result partition — otherwise `graphConsolidateJob` returns normally,
    // `completeMemoryJob()` marks the job done, and consolidation is silently
    // skipped for a full interval. Re-throwing lets `handleJobError` /
    // `classifyError` defer/retry the job.
    await expect(
      runConsolidation(SCOPE, DEFAULT_CONFIG),
    ).rejects.toBeInstanceOf(BackendUnavailableError);

    // The dupe-scan ran (no dupes) and the chunk-consolidation call was reached
    // before the timeout fired — proving the re-throw came from the chunk pass,
    // not an earlier failure.
    expect(toolCalls).toContain("report_duplicate_groups");
    expect(toolCalls).toContain("consolidate_diff");
  });
});

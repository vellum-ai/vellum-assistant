import { describe, expect, test } from "bun:test";

import { shouldRunLegacyMemoryRetrieval } from "../user-prompt-submit.js";

/**
 * Legacy (v1/v2) graph-memory retrieval is the deprecated path — the gate
 * covers both pre-v3 engines, which `prepareMemory` dispatches between
 * internally. It is gated off under `memory-v3-live` — v3 owns the
 * injected-memory layer and runtime assembly strips any legacy `<memory>`
 * block, so running the legacy per-turn retrieval (embedding + hybrid search
 * + the `memoryRetrieval` LLM router) would only have its result discarded.
 * It is also skipped for untrusted actors. The conversation/abort-signal
 * presence checks stay inline at the call site (for type narrowing) and are
 * deliberately NOT part of this policy decision.
 */
describe("shouldRunLegacyMemoryRetrieval", () => {
  test("runs for a trusted actor when memory-v3-live is off (v1/v2 path)", () => {
    expect(
      shouldRunLegacyMemoryRetrieval({
        isTrustedActor: true,
        memoryV3Live: false,
      }),
    ).toBe(true);
  });

  test("is skipped under memory-v3-live even for a trusted actor", () => {
    // The cutover: v3 owns memory, so legacy retrieval (and its LLM router)
    // must not fire — this is the per-turn cost the gate removes.
    expect(
      shouldRunLegacyMemoryRetrieval({
        isTrustedActor: true,
        memoryV3Live: true,
      }),
    ).toBe(false);
  });

  test("is skipped for an untrusted actor regardless of the flag", () => {
    expect(
      shouldRunLegacyMemoryRetrieval({
        isTrustedActor: false,
        memoryV3Live: false,
      }),
    ).toBe(false);
    expect(
      shouldRunLegacyMemoryRetrieval({
        isTrustedActor: false,
        memoryV3Live: true,
      }),
    ).toBe(false);
  });
});

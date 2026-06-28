import { describe, expect, test } from "bun:test";

import { shouldRunV2Retrieval } from "../user-prompt-submit.js";

/**
 * v2 graph-memory retrieval is the deprecated path. It is gated off under
 * `memory-v3-live` — v3 owns the injected-memory layer and runtime assembly
 * strips any v2 `<memory>` block, so running v2's per-turn retrieval (embedding
 * + hybrid search + the `memoryRetrieval` LLM router) would only have its
 * result discarded. It is also skipped for untrusted actors and whenever the
 * built-in memory layer is suppressed (`memoryInjectionSuppressed`) —
 * `memory.provider: "none"` or an active external memory plugin. The
 * conversation/abort-signal presence checks stay inline at the call site (for
 * type narrowing) and are deliberately NOT part of this policy decision.
 */
describe("shouldRunV2Retrieval", () => {
  test("runs for a trusted actor when memory-v3-live is off and memory is enabled", () => {
    expect(
      shouldRunV2Retrieval({
        isTrustedActor: true,
        memoryV3Live: false,
        memoryInjectionSuppressed: false,
      }),
    ).toBe(true);
  });

  test("is skipped under memory-v3-live even for a trusted actor", () => {
    // The cutover: v3 owns memory, so v2 retrieval (and its LLM router) must
    // not fire — this is the per-turn cost the gate removes.
    expect(
      shouldRunV2Retrieval({
        isTrustedActor: true,
        memoryV3Live: true,
        memoryInjectionSuppressed: false,
      }),
    ).toBe(false);
  });

  test("is skipped when the built-in memory layer is suppressed — no retrieval, no <memory> injection", () => {
    // `memoryInjectionSuppressed` covers `memory.provider: "none"` AND an active
    // external memory plugin: in both, retrieval (which prepends the v2
    // `<memory>` block onto the tail user message) must not run, so the turn
    // carries no built-in injected memory — while the non-memory runtime blocks
    // this hook also assembles still fire.
    expect(
      shouldRunV2Retrieval({
        isTrustedActor: true,
        memoryV3Live: false,
        memoryInjectionSuppressed: true,
      }),
    ).toBe(false);
  });

  test("is skipped for an untrusted actor regardless of the other gates", () => {
    expect(
      shouldRunV2Retrieval({
        isTrustedActor: false,
        memoryV3Live: false,
        memoryInjectionSuppressed: false,
      }),
    ).toBe(false);
    expect(
      shouldRunV2Retrieval({
        isTrustedActor: false,
        memoryV3Live: true,
        memoryInjectionSuppressed: false,
      }),
    ).toBe(false);
  });
});

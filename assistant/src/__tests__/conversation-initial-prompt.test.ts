/**
 * Tests for construction-time system-prompt resolution.
 *
 * A conversation's system prompt is built once at construction and frozen for
 * every turn (the agent loop never re-resolves it), so the persona slot must
 * resolve correctly here. The guardian binding the persona resolver reads is
 * gateway-owned and only populated asynchronously, so the default-build path
 * must warm it BEFORE building — otherwise a cold cache pins `users/default.md`
 * for the conversation's lifetime.
 *
 * Dependency seams are injected so this exercises the sequencing without mocking
 * the widely-imported guardian-delivery / system-prompt modules (those global
 * module mocks leak across files in the shared-process test runner).
 */
import { describe, expect, test } from "bun:test";

import {
  resolveInitialSystemPrompt,
  warmGuardianBindings,
} from "../daemon/conversation-initial-prompt.js";
import type { ConversationCreateOptions } from "../daemon/handlers/shared.js";

function recordingDeps(calls: string[]): {
  warm: () => Promise<void>;
  build: () => string;
} {
  return {
    warm: async () => {
      calls.push("warm");
    },
    build: () => {
      calls.push("build");
      return "BUILD";
    },
  };
}

describe("warmGuardianBindings", () => {
  test("warms both the vellum-channel key and the unfiltered fallback key", async () => {
    const keys: string[] = [];
    await warmGuardianBindings(async (input) => {
      keys.push(input?.channelTypes?.join(",") ?? "ALL");
      return null;
    });
    // Both keys the persona resolver reads — peekGuardianForChannel("vellum")
    // and its peekAnyGuardian() fallback — must be warmed.
    expect(keys.sort()).toEqual(["ALL", "vellum"]);
  });
});

describe("resolveInitialSystemPrompt", () => {
  test("warms the guardian binding before building the default prompt", async () => {
    const calls: string[] = [];
    const result = await resolveInitialSystemPrompt(
      undefined,
      recordingDeps(calls),
    );

    expect(result).toBe("BUILD");
    // Regression: the warm MUST precede the build so the persona slot resolves
    // the guardian's users/<slug>.md instead of users/default.md on a cold
    // gateway-binding cache.
    expect(calls).toEqual(["warm", "build"]);
  });

  test("an explicit override is used verbatim and skips the warm and build", async () => {
    const calls: string[] = [];
    const result = await resolveInitialSystemPrompt(
      { systemPromptOverride: "CUSTOM PROMPT" } as ConversationCreateOptions,
      recordingDeps(calls),
    );

    expect(result).toBe("CUSTOM PROMPT");
    expect(calls).toEqual([]);
  });

  test("an explicit empty-string override is honored verbatim (not treated as absent)", async () => {
    const calls: string[] = [];
    const result = await resolveInitialSystemPrompt(
      { systemPromptOverride: "" } as ConversationCreateOptions,
      recordingDeps(calls),
    );

    expect(result).toBe("");
    expect(calls).toEqual([]);
  });
});

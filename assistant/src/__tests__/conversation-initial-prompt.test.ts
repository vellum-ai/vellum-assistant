/**
 * Tests for construction-time system-prompt resolution.
 *
 * A conversation's system prompt is built once at construction and frozen for
 * every turn (the agent loop never re-resolves it), so the persona slot must
 * resolve correctly here. The guardian binding the persona resolver reads is
 * gateway-owned and only populated asynchronously, so the default-build path
 * must warm it (`getGuardianDelivery`) BEFORE calling `buildSystemPrompt()` —
 * otherwise a cold cache pins `users/default.md` for the conversation's
 * lifetime.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreateOptions } from "../daemon/handlers/shared.js";

const calls: string[] = [];

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async (input?: { channelTypes?: string[] }) => {
    calls.push(`warm:${input?.channelTypes?.join(",") ?? "ALL"}`);
    return null;
  },
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => {
    calls.push("build");
    return "DEFAULT_BUILD";
  },
}));

import { resolveInitialSystemPrompt } from "../daemon/conversation-initial-prompt.js";

describe("resolveInitialSystemPrompt", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test("warms both guardian-binding cache keys before building the default prompt", async () => {
    const result = await resolveInitialSystemPrompt(undefined);

    expect(result).toBe("DEFAULT_BUILD");
    // Regression: both keys the persona resolver reads — the "vellum" key and
    // the unfiltered (peekAnyGuardian) key — must be warmed before the build so
    // the persona slot resolves the guardian's users/<slug>.md instead of
    // users/default.md on a cold gateway-binding cache, regardless of which
    // channel the guardian lives on.
    expect(calls).toEqual(["warm:vellum", "warm:ALL", "build"]);
  });

  test("an explicit override is used verbatim and skips the warm and build", async () => {
    const result = await resolveInitialSystemPrompt({
      systemPromptOverride: "CUSTOM PROMPT",
    } as ConversationCreateOptions);

    expect(result).toBe("CUSTOM PROMPT");
    expect(calls).toEqual([]);
  });

  test("an explicit empty-string override is honored verbatim (not treated as absent)", async () => {
    const result = await resolveInitialSystemPrompt({
      systemPromptOverride: "",
    } as ConversationCreateOptions);

    expect(result).toBe("");
    expect(calls).toEqual([]);
  });
});

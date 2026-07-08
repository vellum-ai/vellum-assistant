/**
 * Tests for construction-time system-prompt resolution.
 *
 * A conversation's system prompt is built once at construction and frozen for
 * every turn (the agent loop never re-resolves it), so the persona slot must
 * resolve correctly here. With no construction-time identity the default-build
 * path must warm the gateway guardian binding BEFORE building (else a cold cache
 * pins `users/default.md`); a channel-routed conversation that already carries
 * the requester's trust context must build with it so the requester's profile
 * resolves instead of the guardian/default one.
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
import type { TrustContext } from "../daemon/trust-context-types.js";

function spyDeps() {
  const calls: string[] = [];
  const builtWith: Array<TrustContext | undefined> = [];
  return {
    calls,
    builtWith,
    deps: {
      warm: async () => {
        calls.push("warm");
      },
      build: (trustContext: TrustContext | undefined) => {
        calls.push("build");
        builtWith.push(trustContext);
        return "BUILD";
      },
    },
  };
}

const REQUESTER_TRUST = {
  sourceChannel: "slack",
  trustClass: "trusted_contact",
  requesterExternalUserId: "user-123",
} as unknown as TrustContext;

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
  test("no construction-time identity: warms the guardian binding, then builds with no trust context", async () => {
    const { calls, builtWith, deps } = spyDeps();
    const result = await resolveInitialSystemPrompt(undefined, deps);

    expect(result).toBe("BUILD");
    // The warm MUST precede the build so the persona slot resolves the
    // guardian's users/<slug>.md instead of users/default.md on a cold cache.
    expect(calls).toEqual(["warm", "build"]);
    expect(builtWith).toEqual([undefined]);
  });

  test("channel-routed: threads the requester trust context and skips the guardian warm", async () => {
    const { calls, builtWith, deps } = spyDeps();
    const result = await resolveInitialSystemPrompt(
      { trustContext: REQUESTER_TRUST } as ConversationCreateOptions,
      deps,
    );

    expect(result).toBe("BUILD");
    // The requester's identity resolves the persona via a DB lookup, so no
    // guardian-cache warm is needed and the trust context must reach the build.
    expect(calls).toEqual(["build"]);
    expect(builtWith).toEqual([REQUESTER_TRUST]);
  });

  test("an explicit override is used verbatim and skips the warm and build", async () => {
    const { calls, deps } = spyDeps();
    const result = await resolveInitialSystemPrompt(
      { systemPromptOverride: "CUSTOM PROMPT" } as ConversationCreateOptions,
      deps,
    );

    expect(result).toBe("CUSTOM PROMPT");
    expect(calls).toEqual([]);
  });

  test("an explicit empty-string override is honored verbatim (not treated as absent)", async () => {
    const { calls, deps } = spyDeps();
    const result = await resolveInitialSystemPrompt(
      { systemPromptOverride: "" } as ConversationCreateOptions,
      deps,
    );

    expect(result).toBe("");
    expect(calls).toEqual([]);
  });
});

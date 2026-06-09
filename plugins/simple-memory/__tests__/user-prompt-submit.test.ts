/**
 * Behavioral tests for the simple-memory `user-prompt-submit` hook.
 *
 * Lives with the plugin (not the daemon) — exercises the hook in
 * isolation with a synthetic `UserPromptSubmitContext`, so the test
 * doesn't need the daemon's pipeline runner / agent loop. The hook only
 * touches `ctx.latestMessages` + reads `ctx.messages`, so we can use any
 * opaque value as a Message stand-in at runtime.
 *
 * Run manually (plugin tests are intentionally not in the assistant's
 * CI glob today):
 *
 *   cd assistant && bun test \
 *     ../plugins/simple-memory/__tests__/user-prompt-submit.test.ts
 */

import { describe, expect, test } from "bun:test";

import userPromptSubmit from "../hooks/user-prompt-submit.ts";

// Message has rich provider-aligned shape; the hook only treats elements
// as opaque values, so a tagged sentinel is fine for behavioral coverage.
type FakeMessage = { tag: string };

function msg(tag: string): FakeMessage {
  return { tag };
}

function makeCtx(
  originalMessages: FakeMessage[],
  latestMessages: FakeMessage[],
  conversationId = "conv-A",
) {
  return {
    conversationId,
    // Cast through `unknown` since the test uses a stand-in Message
    // shape — runtime semantics are identical and the hook never reads
    // any Message field.
    originalMessages: originalMessages as unknown as ReadonlyArray<never>,
    latestMessages: latestMessages as unknown as never[],
  };
}

describe("simple-memory user-prompt-submit hook", () => {
  test("clears latestMessages and resets to messages (the original)", async () => {
    const original = [msg("a"), msg("b")];
    const latest = [
      msg("a"),
      msg("b"),
      msg("injected-pkb"),
      msg("injected-now"),
    ];
    const ctx = makeCtx(original, latest);

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages).toEqual(original as unknown as never[]);
  });

  test("mutates `latestMessages` in place (same array reference)", async () => {
    const original = [msg("a")];
    const latest = [msg("a"), msg("injected")];
    const ctx = makeCtx(original, latest);
    const sameRef = ctx.latestMessages;

    await userPromptSubmit(ctx);

    // Mutation-style hook: latestMessages array reference is preserved.
    expect(ctx.latestMessages).toBe(sameRef);
  });

  test("works when latestMessages is identical to messages (no-op semantics)", async () => {
    const original = [msg("a"), msg("b")];
    const latest = [...original];
    const ctx = makeCtx(original, latest);

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages).toEqual(original as unknown as never[]);
  });

  test("works when latestMessages is empty", async () => {
    const original = [msg("a"), msg("b")];
    const ctx = makeCtx(original, []);

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages).toEqual(original as unknown as never[]);
  });

  test("works when messages is empty (edge case)", async () => {
    const ctx = makeCtx([], [msg("injected")]);

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages).toEqual([]);
  });

  test("returns void (mutation-style convention)", async () => {
    const original = [msg("a")];
    const ctx = makeCtx(original, [...original]);

    const result = await userPromptSubmit(ctx);

    expect(result).toBeUndefined();
  });

  test("does not mutate the original messages array", async () => {
    const original = [msg("a"), msg("b")];
    const originalSnapshot = [...original];
    const ctx = makeCtx(original, [msg("injected")]);

    await userPromptSubmit(ctx);

    expect(original).toEqual(originalSnapshot);
    expect(original).toHaveLength(2);
  });

  test("does not snapshot — subsequent mutations to messages would leak (documents pass-through semantics)", async () => {
    // The hook spreads `ctx.messages` into `latestMessages` via push,
    // which COPIES references but creates a new array. Future mutations
    // to `messages` (which plugin code shouldn't do, per the readonly
    // contract) won't reflect into `latestMessages`. Documenting here
    // to flag the surface for future authors.
    const m1 = msg("a");
    const m2 = msg("b");
    const original = [m1, m2];
    const ctx = makeCtx(original, [msg("injected")]);

    await userPromptSubmit(ctx);

    expect(ctx.latestMessages).toEqual([m1, m2] as unknown as never[]);
    // Confirm element-identity: pushed references are the same objects.
    expect(ctx.latestMessages[0]).toBe(m1 as unknown as never);
    expect(ctx.latestMessages[1]).toBe(m2 as unknown as never);
  });
});

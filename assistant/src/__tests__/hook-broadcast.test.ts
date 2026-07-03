/**
 * Tests for the `user-prompt-submit` hook `broadcast` capability and the
 * pipeline's per-hook binding that powers it.
 *
 * A hook calls `ctx.broadcast(detail)`; the pipeline (`runHook`) stamps a fresh
 * `broadcast` onto each hook's context before it runs, bound to the hook's
 * owner and — when present — the conversation. The closure emits exactly one
 * `hook_event` through the shared `broadcastMessage` hub. This suite locks:
 *  - each hook's emit is attributed to its own `{ kind, id }` owner, in order;
 *  - the emit carries the conversation when the context has one, and omits it
 *    otherwise (unscoped);
 *  - a hook that never broadcasts emits nothing;
 *  - `HookEventSchema` validates the emitted shape.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The pipeline's `broadcast` emits through the shared hub. Stub it so tests can
// assert exactly what each hook emits without a live event hub.
const broadcastMessageMock = mock(
  (_msg: unknown, _conversationId?: string) => {},
);
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: broadcastMessageMock,
}));

import { HookEventSchema } from "../api/events/hook-event.js";
import type { UserPromptSubmitContext } from "../plugin-api/types.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { HookFunction, Plugin } from "../plugins/types.js";

// Point the workspace at an empty temp dir so the user-land hook loader finds
// nothing; only the in-process hooks registered below participate.
process.env.VELLUM_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-hook-broadcast-${process.pid}-${Date.now()}`,
);

function buildPlugin(
  name: string,
  hook: HookFunction<UserPromptSubmitContext>,
): Plugin {
  return {
    manifest: { name, version: "1.0.0" },
    hooks: { "user-prompt-submit": hook as HookFunction },
  };
}

function baseCtx(
  overrides: Partial<UserPromptSubmitContext> = {},
): UserPromptSubmitContext {
  return {
    conversationId: "conv-1",
    userMessageId: "req-1",
    requestId: "req-1",
    modelProfileKey: "balanced",
    isNonInteractive: false,
    prompt: "hello",
    originalMessages: [],
    latestMessages: [],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as UserPromptSubmitContext["logger"],
    // Placeholder — the pipeline rebinds this per hook.
    broadcast: () => {},
    ...overrides,
  };
}

/** The `hook_event` messages passed to the stubbed `broadcastMessage`. */
function emittedHookEvents() {
  return broadcastMessageMock.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.type === "hook_event");
}

describe("user-prompt-submit broadcast capability", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    broadcastMessageMock.mockReset();
  });
  afterEach(() => resetPluginRegistryForTests());

  test("each hook's broadcast is attributed to its own owner, in order", async () => {
    registerPlugin(
      buildPlugin("owner-a", (ctx) => {
        ctx.broadcast({ step: "a" });
        return Promise.resolve();
      }),
    );
    registerPlugin(
      buildPlugin("owner-b", (ctx) => {
        ctx.broadcast({ step: "b" });
        return Promise.resolve();
      }),
    );

    await runHook("user-prompt-submit", baseCtx());

    expect(emittedHookEvents()).toEqual([
      {
        type: "hook_event",
        conversationId: "conv-1",
        hookName: "user-prompt-submit",
        owner: { kind: "plugin", id: "owner-a" },
        detail: { step: "a" },
      },
      {
        type: "hook_event",
        conversationId: "conv-1",
        hookName: "user-prompt-submit",
        owner: { kind: "plugin", id: "owner-b" },
        detail: { step: "b" },
      },
    ]);
  });

  test("emits unscoped (no conversationId) when the context has none", async () => {
    registerPlugin(
      buildPlugin("owner-a", (ctx) => {
        ctx.broadcast({ step: "a" });
        return Promise.resolve();
      }),
    );

    // A context without a conversationId — the emit path must tolerate it.
    await runHook(
      "user-prompt-submit",
      baseCtx({ conversationId: undefined as unknown as string }),
    );

    const events = emittedHookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBeUndefined();
    expect(events[0]!.owner).toEqual({ kind: "plugin", id: "owner-a" });
  });

  test("sanitizes unserializable detail instead of throwing into the hook", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let ranPastBroadcast = false;
    registerPlugin(
      buildPlugin("owner-a", (ctx) => {
        ctx.broadcast(circular);
        ranPastBroadcast = true;
        return Promise.resolve();
      }),
    );

    await runHook("user-prompt-submit", baseCtx());

    // The broadcast never throws into the hook; the payload is replaced with
    // a marker so the emitted event stays JSON-serializable.
    expect(ranPastBroadcast).toBe(true);
    const events = emittedHookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ unserializableDetail: true });
  });

  test("a hook that never broadcasts emits nothing", async () => {
    registerPlugin(buildPlugin("owner-quiet", () => Promise.resolve()));

    await runHook("user-prompt-submit", baseCtx());

    expect(emittedHookEvents()).toEqual([]);
  });

  test("HookEventSchema validates the emitted shape", () => {
    const parsed = HookEventSchema.parse({
      type: "hook_event",
      conversationId: "conv-1",
      hookName: "user-prompt-submit",
      owner: { kind: "plugin", id: "owner-a" },
      detail: { phase: "selecting", count: 3 },
    });
    expect(parsed.owner).toEqual({ kind: "plugin", id: "owner-a" });
    expect(parsed.detail.count).toBe(3);
  });
});

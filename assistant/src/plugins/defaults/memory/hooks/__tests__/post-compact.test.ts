/**
 * Tests for the memory plugin's `post-compact` hook.
 *
 * The hook re-applies runtime injections onto the compacted continuation
 * history. Its blocks are never persisted (the captured blocks are dropped,
 * and every message in the base predates the compaction's
 * `historyStrippedAt` marker), so it must run the assembly as a
 * `reinjection`: runtime assembly then withholds the memory-v3 sections
 * injector's residency commit, keeping the section store from claiming a
 * copy a restart cannot rehydrate.
 *
 * `mock.module` is process-global, so the assembly stub delegates to the
 * real implementation unless this file is running (`hookMockActive`).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PostCompactContext } from "@vellumai/plugin-api";

import type { Message } from "../../../../../providers/types.js";

const realAssembly = {
  ...(await import("../../../../../daemon/conversation-runtime-assembly.js")),
};
type ApplyRuntimeInjections = typeof realAssembly.applyRuntimeInjections;

let hookMockActive = false;
const calls: Array<{
  messages: Message[];
  options: Parameters<ApplyRuntimeInjections>[1];
}> = [];
let reinjectedHistory: Message[] = [];
mock.module("../../../../../daemon/conversation-runtime-assembly.js", () => ({
  ...realAssembly,
  applyRuntimeInjections: (async (messages, options) => {
    if (!hookMockActive) {
      return realAssembly.applyRuntimeInjections(messages, options);
    }
    calls.push({ messages, options });
    return { messages: reinjectedHistory, blocks: {} } as Awaited<
      ReturnType<ApplyRuntimeInjections>
    >;
  }) satisfies ApplyRuntimeInjections,
}));

const { default: postCompact } = await import("../post-compact.js");

function makeContext(history: Message[]): PostCompactContext {
  return {
    history,
    requestId: "req-1",
    conversationId: "conv-post-compact",
    isNonInteractive: false,
    modelProfileKey: "profile-1",
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as PostCompactContext["logger"],
    broadcast: (() => {}) as unknown as PostCompactContext["broadcast"],
  };
}

describe("memory post-compact hook", () => {
  beforeEach(() => {
    hookMockActive = true;
    calls.length = 0;
    reinjectedHistory = [
      { role: "user", content: [{ type: "text", text: "re-injected" }] },
    ];
  });

  afterAll(() => {
    hookMockActive = false;
  });

  test("re-applies the injections as a reinjection assembly onto the tail-stripped base and writes the result back", async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<memory>\nfrozen sections\n</memory>" },
          { type: "text", text: "tool result" },
        ],
      },
    ];
    const ctx = makeContext(history);

    await postCompact(ctx);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.options.reinjection).toBe(true);
    expect(call.options.conversationId).toBe("conv-post-compact");
    expect(call.options.requestId).toBe("req-1");
    expect(call.options.mode).toBe("full");
    // The tail's per-turn blocks are cleared before re-injection so the
    // continuation history holds a single copy of each.
    expect(call.messages[2]!.content).toEqual([
      { type: "text", text: "tool result" },
    ]);
    expect(ctx.history).toBe(reinjectedHistory);
  });

  test("forwards the overflow ladder's injection downgrade as the assembly mode", async () => {
    const ctx: PostCompactContext = {
      ...makeContext([
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ]),
      injectionMode: "minimal",
    };

    await postCompact(ctx);

    expect(calls[0]!.options.mode).toBe("minimal");
    expect(calls[0]!.options.reinjection).toBe(true);
  });
});

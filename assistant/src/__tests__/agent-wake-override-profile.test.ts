/**
 * Regression test for the wake-driven override-profile gap.
 *
 * `wakeAgentForOpportunity` invokes `agentLoop.run(...)` directly, bypassing
 * `runAgentLoopImpl`. Without an explicit row read, scheduled-task wakes and
 * other opportunity wakes targeting a user conversation with a pinned profile
 * would execute under workspace defaults — silently violating the user's
 * pinned preference.
 *
 * This test pins `getConversationOverrideProfile` to return a fixed profile
 * name and asserts that the wake forwards it to `agentLoop.run` as the
 * `overrideProfile` positional argument. A second case verifies the absence
 * path (no row override → `undefined` propagated).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockOverrideProfile: string | undefined = undefined;

mock.module("../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: (_id: string) => mockOverrideProfile,
}));

import type { AgentEvent } from "../agent/loop.js";
import type { Message } from "../providers/types.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeTarget,
} from "../runtime/agent-wake.js";

interface RunArgs {
  messages: Message[];
  signal: AbortSignal | undefined;
  requestId: string | undefined;
  onCheckpoint: unknown;
  callSite: unknown;
  turnContext: unknown;
  overrideProfile: string | undefined;
}

function makeTarget(): {
  target: WakeTarget;
  runArgs: RunArgs[];
} {
  const runArgs: RunArgs[] = [];
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  let processing = false;

  const target: WakeTarget = {
    conversationId: "conv-wake-override",
    agentLoop: {
      run: (async (
        messages: Message[],
        _onEvent: (event: AgentEvent) => void | Promise<void>,
        signal?: AbortSignal,
        requestId?: string,
        onCheckpoint?: unknown,
        callSite?: unknown,
        turnContext?: unknown,
        overrideProfile?: string,
      ) => {
        runArgs.push({
          messages: [...messages],
          signal,
          requestId,
          onCheckpoint,
          callSite,
          turnContext,
          overrideProfile,
        });
        // Return the input verbatim → silent no-op (no assistant tail).
        return messages;
      }) as WakeTarget["agentLoop"]["run"],
    },
    getMessages: () => history,
    pushMessage: (msg) => {
      history.push(msg);
    },
    emitAgentEvent: () => {},
    isProcessing: () => processing,
    markProcessing: (on) => {
      processing = on;
    },
    persistTailMessage: async () => {},
  };
  return { target, runArgs };
}

beforeEach(() => {
  __resetWakeChainForTests();
});

afterEach(() => {
  mockOverrideProfile = undefined;
});

describe("wakeAgentForOpportunity — overrideProfile forwarding", () => {
  test("forwards the conversation's pinned overrideProfile to agentLoop.run", async () => {
    mockOverrideProfile = "frontier";
    const { target, runArgs } = makeTarget();

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(result.invoked).toBe(true);
    expect(runArgs).toHaveLength(1);
    // The 8th positional argument (after messages, onEvent, signal,
    // requestId, onCheckpoint, callSite, turnContext) is overrideProfile.
    expect(runArgs[0]!.overrideProfile).toBe("frontier");
    // Sanity: the wake-source tag still propagates as requestId.
    expect(runArgs[0]!.requestId).toBe("wake:scheduler");
  });

  test("passes undefined when the conversation has no pinned profile", async () => {
    mockOverrideProfile = undefined;
    const { target, runArgs } = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(runArgs).toHaveLength(1);
    expect(runArgs[0]!.overrideProfile).toBeUndefined();
  });
});

/**
 * A direct wake runs under its own prompt, not the last app turn's.
 *
 * `wakeAgentForOpportunity` drives `agentLoop.run` itself, so the loop holds
 * whatever prompt the conversation last synced. The parallel-delegation
 * section is gated on the turn's resolved tool surface, so without a re-sync a
 * restricted wake would inherit an app turn's instruction to hand independent
 * work to subagents it cannot spawn, and an unrestricted wake following a
 * restricted turn would be told not to. The wake syncs under its own scope and
 * restores the prompt with the rest of what it scoped.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversationOverrideProfile: () => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

import type { AgentLoopRunOptions } from "../agent/loop.js";
import type { Conversation } from "../daemon/conversation.js";
import { canSpawnSubagentsForTurn } from "../daemon/conversation-tool-setup.js";
import type { Message } from "../providers/types.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
} from "../runtime/agent-wake.js";

/** Stands in for the `01-parallel-tasks` section's rendered body. */
const DELEGATION_SECTION = "[delegation section]";

function makeTarget(onRun: (conv: Conversation) => void): {
  target: Conversation;
  loopPrompt: () => string;
} {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  let processing = false;
  let loopPrompt = "";

  const target = {
    conversationId: "conv-wake-delegation",
    currentCallSite: "mainAgent",
    toolsDisabledDepth: 0,
    hasNoClient: false,
    agentLoop: {
      run: async (options: AgentLoopRunOptions) => {
        onRun(target as unknown as Conversation);
        return { history: options.messages, exitReason: null };
      },
      setSystemPrompt: (prompt: string) => {
        loopPrompt = prompt;
      },
    },
    messages,
    trimAgedSightFrames: (msgs: Message[]) => msgs,
    getMessages: () => messages,
    isProcessing: () => processing,
    waitForIdle: async () => !processing,
    setProcessing: (on: boolean) => {
      processing = on;
    },
    setTrustContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {},
    kickDrainQueue: async () => {},
    maybeCompact: async () => null,
    // The wake scope the allowlist is applied through, which is what the
    // delegation gate reads.
    subagentAllowedTools: undefined as ReadonlySet<string> | undefined,
    subagentToolGateMode: undefined as string | undefined,
    toolContextPin: undefined,
    preactivatedSkillIds: undefined as readonly string[] | undefined,
    setSubagentAllowedTools: (tools?: ReadonlySet<string>) => {
      target.subagentAllowedTools = tools;
    },
    setPreactivatedSkillIds: (ids?: readonly string[]) => {
      target.preactivatedSkillIds = ids;
    },
    // The section's gate, rendered as a marker so the assertions turn on the
    // real predicate rather than on a stubbed answer.
    buildCurrentSystemPrompt: () =>
      canSpawnSubagentsForTurn(target as unknown as Conversation)
        ? `base ${DELEGATION_SECTION}`
        : "base",
    // Mirrors `Conversation.syncLoopSystemPrompt`.
    syncLoopSystemPrompt: () => {
      const next = (
        target as unknown as Conversation
      ).buildCurrentSystemPrompt();
      if (next === target.systemPrompt) {
        return;
      }
      target.systemPrompt = next;
      target.agentLoop.setSystemPrompt(next);
    },
    systemPrompt: "",
    modelOverride: undefined,
  };
  return {
    target: target as unknown as Conversation,
    loopPrompt: () => loopPrompt,
  };
}

beforeEach(() => {
  __resetWakeChainForTests();
});

describe("the delegation section on a direct wake", () => {
  test("a restricted wake drops the section an app turn left behind", async () => {
    let promptDuringRun = "";
    const { target, loopPrompt } = makeTarget(() => {
      promptDuringRun = loopPrompt();
    });

    // An unrestricted app turn ran first and synced the section into the loop,
    // which holds it until something else syncs.
    target.syncLoopSystemPrompt();
    expect(loopPrompt()).toContain(DELEGATION_SECTION);

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
        // A background run scoped to tools that carry no path to a subagent.
        allowedTools: ["file_read", "web_search"],
      },
      { resolveTarget: async () => target },
    );

    expect(promptDuringRun).not.toContain(DELEGATION_SECTION);
    expect(promptDuringRun.length).toBeGreaterThan(0);
  });

  test("an unrestricted wake keeps the section", async () => {
    let promptDuringRun = "";
    const { target, loopPrompt } = makeTarget(() => {
      promptDuringRun = loopPrompt();
    });

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(promptDuringRun).toContain(DELEGATION_SECTION);
  });

  test("the restored prompt is built without the wake's persona", async () => {
    // `wakePersonaOverride` feeds `buildCurrentSystemPrompt`, so a rebuild
    // that ran before the clear would leave the loop holding the wake's
    // persona: the next wake's pre-run compaction gate reads that prompt and
    // would size against a turn that already ended.
    const personaSeen: Array<unknown> = [];
    const { target, loopPrompt } = makeTarget(() => {});
    const buildUnderPersona = () => {
      personaSeen.push(target.wakePersonaOverride);
      return target.wakePersonaOverride
        ? "base [wake persona]"
        : "base [delegation section]";
    };
    (target as unknown as Record<string, unknown>).buildCurrentSystemPrompt =
      buildUnderPersona;

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
        personaOverride: { userSlug: "someone" },
      },
      { resolveTarget: async () => target },
    );

    // The last build saw no override, and that is the prompt the loop keeps.
    expect(personaSeen.at(-1)).toBeUndefined();
    expect(loopPrompt()).toBe("base [delegation section]");
  });

  test("the prompt is restored once the wake's scope comes off", async () => {
    const { target, loopPrompt } = makeTarget(() => {});

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
        allowedTools: ["file_read", "web_search"],
      },
      { resolveTarget: async () => target },
    );

    // Whatever runs next must not inherit the wake's narrowed prompt.
    expect(loopPrompt()).toContain(DELEGATION_SECTION);
  });
});

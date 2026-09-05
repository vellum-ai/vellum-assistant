/**
 * `interrupt-on-send`: a message sent while the assistant is busy stops the
 * turn in flight and is delivered at once instead of joining the queue.
 *
 * Covers the decision (`interruptRunningTurn`) and the history repair it runs
 * before handing an idle conversation back: whether this sender may interrupt,
 * what the abort carries, what is deliberately left alone (subagents, the
 * queue), and what the repaired history looks like.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import type { Message } from "../providers/types.js";
import type { AbortReason } from "../util/abort-reasons.js";
import {
  abortedToolResultText,
  CANCELLED_TOOL_RESULT_TEXT,
  createAbortReason,
  PREEMPTED_TOOL_RESULT_TEXT,
} from "../util/abort-reasons.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the module imports so Bun applies them at load time.
// ---------------------------------------------------------------------------

let flagEnabled = true;
mock.module("../config/interrupt-on-send-gate.js", () => ({
  isInterruptOnSendEnabled: () => flagEnabled,
}));

const persisted: Array<{ role: string; content: string }> = [];
let persistGate: Promise<void> = Promise.resolve();

// Only the persist seam is replaced; every other CRUD export stays real so the
// repair module's import graph resolves as it does in production.
const realConversationCrud =
  await import("../persistence/conversation-crud.js");
mock.module("../persistence/conversation-crud.js", () => ({
  ...realConversationCrud,
  addMessage: async (
    _conversationId: string,
    role: string,
    content: string,
  ) => {
    await persistGate;
    persisted.push({ role, content });
    return { id: `msg-${persisted.length}` };
  },
}));

const { interruptRunningTurn, mayInterruptRunningTurn } =
  await import("../daemon/conversation-interrupt.js");
const { repairInterruptedToolUseBlocks } =
  await import("../daemon/conversation-interrupt-repair.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONV = "interrupt-on-send-conv";

const assistantWithToolUse = (...ids: string[]): Message => ({
  role: "assistant",
  content: ids.map((id) => ({
    type: "tool_use" as const,
    id,
    name: "bash",
    input: {},
  })),
});

const toolResult = (id: string, content: string): Message => ({
  role: "user",
  content: [
    {
      type: "tool_result" as const,
      tool_use_id: id,
      content,
      is_error: true,
    },
  ],
});

/** Every `tool_use` in `messages` that no `tool_result` answers. */
function unmatchedToolUseIds(messages: Message[]): string[] {
  const resolved = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        resolved.add(block.tool_use_id);
      }
    }
  }
  const unmatched: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_use" && !resolved.has(block.id)) {
        unmatched.push(block.id);
      }
    }
  }
  return unmatched;
}

interface FakeTurn {
  conversation: Conversation;
  messages: Message[];
  aborts: AbortReason[];
  activityEvents: Array<{ phase: string; reason: string }>;
  denyAllCount: () => number;
}

/**
 * A conversation whose turn is in flight, exposing only the surface the
 * interrupt touches. `releaseOnAbort` mirrors the ordinary case where the
 * agent loop unwinds and clears the processing flag; leaving it false pins the
 * wedged turn the abort budget exists for.
 */
function registerBusyTurn(
  options: {
    releaseOnAbort?: boolean;
    hasController?: boolean;
    turnActorPrincipalId?: string;
    messages?: Message[];
  } = {},
): FakeTurn {
  const {
    releaseOnAbort = true,
    hasController = true,
    turnActorPrincipalId,
    messages = [],
  } = options;
  const aborts: AbortReason[] = [];
  const activityEvents: Array<{ phase: string; reason: string }> = [];
  let denyAllCount = 0;
  let processing = true;
  const idleWaiters = new Set<() => void>();

  const release = () => {
    if (!processing) {
      return;
    }
    processing = false;
    for (const notify of [...idleWaiters]) {
      notify();
    }
    idleWaiters.clear();
  };

  const fake = {
    conversationId: CONV,
    messages,
    currentTurnSourceActorPrincipalId: turnActorPrincipalId,
    pendingSteerRepair: false,
    pendingInterruptRepair: false,
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      if (value) {
        processing = true;
        return;
      }
      release();
    },
    abortController: hasController
      ? {
          abort: (reason: AbortReason) => {
            aborts.push(reason);
            if (releaseOnAbort) {
              release();
            }
          },
        }
      : null,
    denyAllPendingConfirmations: () => {
      denyAllCount += 1;
    },
    hasAnyPendingConfirmation: () => false,
    emitActivityState: (phase: string, reason: string) => {
      activityEvents.push({ phase, reason });
    },
    waitForIdle: ({ timeoutMs }: { timeoutMs: number }) => {
      if (!processing) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const notify = () => {
          clearTimeout(timer);
          resolve(true);
        };
        // Short-circuit the real budget: a wedged turn must not make the suite
        // wait out the abort watchdog to prove the fallback.
        const timer = setTimeout(
          () => {
            idleWaiters.delete(notify);
            resolve(false);
          },
          Math.min(timeoutMs, 25),
        );
        idleWaiters.add(notify);
      });
    },
  };

  setConversation(CONV, fake as unknown as Conversation);
  return {
    conversation: fake as unknown as Conversation,
    messages,
    aborts,
    activityEvents,
    denyAllCount: () => denyAllCount,
  };
}

beforeEach(() => {
  flagEnabled = true;
  persisted.length = 0;
  persistGate = Promise.resolve();
});

afterEach(() => {
  deleteConversation(CONV);
  // `mock.module` is process-wide, so this stub outlives the file. Leave it
  // reading off, which is the flag's shipped state, so a later file's
  // flag-off expectations are not answered by this file's last setting.
  flagEnabled = false;
});

describe("interruptRunningTurn", () => {
  test("stops the running turn and hands an idle conversation back", async () => {
    const turn = registerBusyTurn();

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("released");
    expect(turn.conversation.isProcessing()).toBe(false);
    expect(turn.aborts).toHaveLength(1);
    expect(turn.aborts[0].kind).toBe("preempted_by_new_message");
    expect(turn.denyAllCount()).toBe(1);
  });

  test("answers the abandoned tool calls before it returns", async () => {
    const turn = registerBusyTurn({
      messages: [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        assistantWithToolUse("tool-1", "tool-2"),
      ],
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(unmatchedToolUseIds(turn.messages)).toEqual([]);
    // The caller writes the new user row after this, so the repair row has to
    // already be there: a user message between a `tool_use` and its result is
    // a sequence every provider rejects.
    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe("user");
  });

  test("forces the repair past the flags the legacy queue path arms", async () => {
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });
    expect(turn.conversation.pendingSteerRepair).toBe(false);
    expect(turn.conversation.pendingInterruptRepair).toBe(false);

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(turn.messages).toHaveLength(2);
  });

  test("returns only once the repair row is durable", async () => {
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });
    let releasePersist = () => {};
    persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });

    let settled = false;
    const pending = interruptRunningTurn(turn.conversation, {
      origin: "test",
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePersist();
    expect(await pending).toBe("released");
    expect(persisted).toHaveLength(1);
  });

  test("tells clients the conversation is working again", async () => {
    const turn = registerBusyTurn();

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(turn.activityEvents).toEqual([
      { phase: "thinking", reason: "message_interrupted" },
    ]);
  });

  test("never reaches for the subagent manager or the ACP cancel", () => {
    // Background subagents keep running across an interrupt; the new turn's
    // model decides what to do about them. Enforced by the interrupt path
    // naming neither of the two teardown surfaces the Stop button uses.
    const source = readFileSync(
      new URL("../daemon/conversation-interrupt.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("getSubagentManager");
    expect(source).not.toContain("cancelForParent");
  });

  test("declines when the flag is off, touching nothing", async () => {
    flagEnabled = false;
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("declined");
    expect(turn.aborts).toEqual([]);
    expect(turn.denyAllCount()).toBe(0);
    expect(turn.messages).toHaveLength(1);
    expect(persisted).toEqual([]);
    expect(turn.conversation.isProcessing()).toBe(true);
  });

  test("declines when another actor principal owns the running turn", async () => {
    const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
      callerActorPrincipalId: "actor-b",
    });

    expect(outcome).toBe("declined");
    expect(turn.aborts).toEqual([]);
    expect(turn.conversation.isProcessing()).toBe(true);
  });

  test("interrupts when the same actor principal owns the running turn", async () => {
    const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
      callerActorPrincipalId: "actor-a",
    });

    expect(outcome).toBe("released");
    expect(turn.aborts).toHaveLength(1);
  });

  test("falls back to the queue when the turn never releases the lock", async () => {
    const turn = registerBusyTurn({
      releaseOnAbort: false,
      messages: [assistantWithToolUse("tool-1")],
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("busy");
    expect(turn.aborts).toHaveLength(1);
    // The turn is still unwinding, so its history is not ours to rewrite.
    expect(turn.messages).toHaveLength(1);
  });

  test("force-clears a processing flag latched with no live turn behind it", async () => {
    const turn = registerBusyTurn({ hasController: false });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("released");
    expect(turn.conversation.isProcessing()).toBe(false);
  });

  test("a second interrupt stops the turn the first one started", async () => {
    const turn = registerBusyTurn();

    expect(
      await interruptRunningTurn(turn.conversation, { origin: "first" }),
    ).toBe("released");

    // The new turn takes the lock, exactly as the send path's dispatch would.
    turn.conversation.setProcessing(true);

    expect(
      await interruptRunningTurn(turn.conversation, { origin: "second" }),
    ).toBe("released");
    expect(turn.aborts).toHaveLength(2);
    expect(turn.activityEvents).toHaveLength(2);
  });
});

describe("mayInterruptRunningTurn", () => {
  test("allows a caller with no actor principal, who is the guardian", () => {
    const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });
    expect(mayInterruptRunningTurn(turn.conversation, undefined)).toBe(true);
  });

  test("allows any caller when the running turn records no requester", () => {
    const turn = registerBusyTurn();
    expect(mayInterruptRunningTurn(turn.conversation, "actor-b")).toBe(true);
  });

  test("refuses a different actor principal", () => {
    const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });
    expect(mayInterruptRunningTurn(turn.conversation, "actor-b")).toBe(false);
  });
});

describe("repairInterruptedToolUseBlocks", () => {
  function fakeConversation(messages: Message[]): Conversation {
    return {
      conversationId: CONV,
      messages,
      pendingSteerRepair: false,
      pendingInterruptRepair: false,
    } as unknown as Conversation;
  }

  test("writes one result per abandoned call, worded for a preemption", async () => {
    const messages: Message[] = [assistantWithToolUse("tool-1", "tool-2")];

    await repairInterruptedToolUseBlocks(fakeConversation(messages), {
      force: true,
    });

    expect(messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: PREEMPTED_TOOL_RESULT_TEXT,
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: PREEMPTED_TOOL_RESULT_TEXT,
          is_error: true,
        },
      ],
    });
    expect(JSON.parse(persisted[0].content)).toEqual(
      messages[1].content as unknown as unknown[],
    );
  });

  test("adds nothing when the loop already wrote its own results", async () => {
    // The agent loop's abort handler synthesizes results of its own when it
    // unwinds cleanly, so exactly one result per call exists either way.
    const messages: Message[] = [
      assistantWithToolUse("tool-1"),
      toolResult("tool-1", PREEMPTED_TOOL_RESULT_TEXT),
    ];

    await repairInterruptedToolUseBlocks(fakeConversation(messages), {
      force: true,
    });

    expect(messages).toHaveLength(2);
    expect(persisted).toEqual([]);
  });

  test("does nothing on a history that ends on an ordinary assistant reply", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    await repairInterruptedToolUseBlocks(fakeConversation(messages), {
      force: true,
    });

    expect(messages).toHaveLength(2);
    expect(persisted).toEqual([]);
  });

  test("stays armed by its flags for the legacy queue path", async () => {
    const messages: Message[] = [assistantWithToolUse("tool-1")];
    const conversation = fakeConversation(messages);

    // Unforced and unarmed: the drain calls this on every pass, and a repair
    // on a history nobody interrupted would answer a call still running.
    await repairInterruptedToolUseBlocks(conversation);
    expect(messages).toHaveLength(1);

    conversation.pendingSteerRepair = true;
    await repairInterruptedToolUseBlocks(conversation);
    expect(messages).toHaveLength(2);
    expect(conversation.pendingSteerRepair).toBe(false);
  });
});

describe("abortedToolResultText", () => {
  test("tells the model a message is waiting when a send preempted the turn", () => {
    const reason = createAbortReason("preempted_by_new_message", "test", CONV);
    expect(abortedToolResultText(reason)).toBe(PREEMPTED_TOOL_RESULT_TEXT);
  });

  test("keeps the plain cancel wording for a user stop", () => {
    const reason = createAbortReason("user_cancel", "test", CONV);
    expect(abortedToolResultText(reason)).toBe(CANCELLED_TOOL_RESULT_TEXT);
  });

  test("reads an untagged abort reason as a plain cancel", () => {
    expect(abortedToolResultText(undefined)).toBe(CANCELLED_TOOL_RESULT_TEXT);
    expect(abortedToolResultText(new Error("boom"))).toBe(
      CANCELLED_TOOL_RESULT_TEXT,
    );
  });
});

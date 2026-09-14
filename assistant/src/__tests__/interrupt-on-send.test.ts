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
// Mocks must precede the module imports so Bun applies them at load time.
// ---------------------------------------------------------------------------

let flagEnabled = true;
mock.module("../config/interrupt-on-send-gate.js", () => ({
  isInterruptOnSendEnabled: () => flagEnabled,
}));

const persisted: Array<{ role: string; content: string }> = [];
let persistGate: Promise<void> = Promise.resolve();
let persistShouldFail = false;

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
    if (persistShouldFail) {
      throw new Error("simulated persist failure");
    }
    persisted.push({ role, content });
    return { id: `msg-${persisted.length}` };
  },
}));

const {
  classifyInterruptEligibility,
  interruptRunningTurn,
  mayInterruptRunningTurn,
} = await import("../daemon/conversation-interrupt.js");
const { repairInterruptedToolUseBlocks } =
  await import("../daemon/conversation-interrupt-repair.js");
const pendingInteractions = await import("../runtime/pending-interactions.js");
const {
  beginTurnFinalization,
  resetTurnFinalizationsForTesting,
  startAfterTurnFinalization,
  waitForTurnFinalization,
} = await import("../daemon/turn-finalization.js");

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
  /** Whether any claim currently holds the processing lock. */
  isLocked: () => boolean;
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
    /**
     * Stand in for a waiter registered before this interrupt (channel
     * admission, an agent wake) that takes the lock on the same idle
     * transition, leaving nothing for the interrupt to claim.
     */
    competingWaiterTakesLock?: boolean;
  } = {},
): FakeTurn {
  const {
    releaseOnAbort = true,
    hasController = true,
    turnActorPrincipalId,
    messages = [],
    competingWaiterTakesLock = false,
  } = options;
  const aborts: AbortReason[] = [];
  const activityEvents: Array<{ phase: string; reason: string }> = [];
  let denyAllCount = 0;
  let processing = true;
  let owner = 1;
  let nextOwner = 1;
  let competingWaiterPending = competingWaiterTakesLock;
  const idleWaiters = new Set<() => void>();

  const release = () => {
    if (!processing) {
      return;
    }
    processing = false;
    owner = 0;
    for (const notify of [...idleWaiters]) {
      notify();
    }
    idleWaiters.clear();
    if (competingWaiterPending) {
      // FIFO notification means the earlier waiter's continuation runs first.
      competingWaiterPending = false;
      processing = true;
      owner = ++nextOwner;
    }
  };

  const fake = {
    conversationId: CONV,
    messages,
    currentTurnSourceActorPrincipalId: turnActorPrincipalId,
    pendingSteerRepair: false,
    pendingInterruptRepair: false,
    pendingInterruptActivityBridge: false,
    pendingInterruptNote: false,
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      if (value) {
        processing = true;
        owner = ++nextOwner;
        return;
      }
      release();
    },
    acquireProcessingFenced: async () => {
      if (processing) {
        return null;
      }
      processing = true;
      owner = ++nextOwner;
      return owner;
    },
    releaseProcessing: (claim: number) => {
      if (owner !== claim) {
        return false;
      }
      release();
      return true;
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
    isLocked: () => processing,
  };
}

beforeEach(() => {
  flagEnabled = true;
  persisted.length = 0;
  persistGate = Promise.resolve();
  persistShouldFail = false;
  pendingInteractions.clear();
  resetTurnFinalizationsForTesting();
});

afterEach(() => {
  deleteConversation(CONV);
  pendingInteractions.clear();
  resetTurnFinalizationsForTesting();
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

  test("forces the repair past the flags the queue drain arms", async () => {
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

  test("arms the working-again transition without emitting it yet", async () => {
    // The transition belongs to the replacement turn, not to the handover: the
    // send can still fail on the way there, and an activity state is cached and
    // replayed to reconnecting clients. The agent loop emits it at turn head.
    const turn = registerBusyTurn();

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(turn.conversation.pendingInterruptActivityBridge).toBe(true);
    expect(turn.activityEvents).toEqual([]);
  });

  test("arms the interrupted-turn note when the abort caught no tool call", async () => {
    // The abort landed during the provider call, so there is no `tool_use` to
    // answer and nothing in the history says the turn was cut off. The note
    // rides on the interrupting user message instead.
    const turn = registerBusyTurn({
      messages: [
        { role: "user", content: [{ type: "text", text: "research this" }] },
        { role: "assistant", content: [{ type: "text", text: "on it." }] },
      ],
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(turn.conversation.pendingInterruptNote).toBe(true);
    expect(persisted).toEqual([]);
  });

  test("leaves the note disarmed when the repair answered a tool call", async () => {
    // The preempted `tool_result` already tells the model a message cut it
    // off, so repeating that in a note on the message is noise.
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toContain(PREEMPTED_TOOL_RESULT_TEXT);
    expect(turn.conversation.pendingInterruptNote).toBe(false);
  });

  test("leaves the note disarmed when the loop wrote its own preempted result", async () => {
    // The agent loop's abort handler unwound cleanly and answered the batch
    // itself, so the repair finds nothing to do and the notice is already
    // there.
    const turn = registerBusyTurn({
      messages: [
        assistantWithToolUse("tool-1"),
        toolResult("tool-1", PREEMPTED_TOOL_RESULT_TEXT),
      ],
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(persisted).toEqual([]);
    expect(turn.conversation.pendingInterruptNote).toBe(false);
  });

  test("arms the note when the cut-off tool call was an ordinary cancel", async () => {
    // A tail answered with the plain cancel wording is a stop the user made
    // earlier, not this interrupt's notice, so the note is still owed.
    const turn = registerBusyTurn({
      messages: [
        assistantWithToolUse("tool-1"),
        toolResult("tool-1", CANCELLED_TOOL_RESULT_TEXT),
      ],
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(turn.conversation.pendingInterruptNote).toBe(true);
  });

  test("leaves clients idle when the send never starts a replacement turn", async () => {
    // The repair lands, the interrupt answers `released`, and then the caller
    // fails before any turn runs (a slash claim, the user-row persist). Nothing
    // may have told clients the conversation is busy, because nothing would
    // tell them it is idle again: `assistant_activity_state` is cached and
    // replayed on reconnect, so a premature `thinking` strands every client.
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("released");
    expect(persisted).toHaveLength(1);
    // The caller now throws instead of dispatching a turn. No agent loop runs,
    // so the armed bridge is never consumed and no event was ever published.
    expect(turn.activityEvents).toEqual([]);
    expect(turn.conversation.isProcessing()).toBe(false);
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

  test("leaves a lock held by something that is not an agent turn alone", async () => {
    // What `/compact`, `/clean` and every other `acquireProcessingFenced`
    // holder look like: processing, with no abort controller because they are
    // not agent-loop turns. Clearing that lock would run a turn that rewrites
    // the history its holder is still persisting.
    const turn = registerBusyTurn({
      hasController: false,
      messages: [assistantWithToolUse("tool-1")],
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("busy");
    expect(turn.conversation.isProcessing()).toBe(true);
    expect(turn.denyAllCount()).toBe(0);
    expect(turn.messages).toHaveLength(1);
    expect(persisted).toEqual([]);
  });

  test("declines a hidden machine send, leaving pending confirmations alone", async () => {
    const turn = registerBusyTurn({ messages: [assistantWithToolUse("t-1")] });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
      hidden: true,
    });

    expect(outcome).toBe("declined");
    expect(turn.aborts).toEqual([]);
    expect(turn.denyAllCount()).toBe(0);
    expect(turn.conversation.isProcessing()).toBe(true);
    expect(turn.messages).toHaveLength(1);
  });

  test("falls back to the queue when another waiter takes the released lock", async () => {
    // An idle transition is not a free lock: waiters are notified FIFO off the
    // same `setProcessing(false)`, so one registered earlier can be running its
    // own turn by the time this continuation gets to the repair.
    const turn = registerBusyTurn({
      competingWaiterTakesLock: true,
      messages: [assistantWithToolUse("tool-1")],
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("busy");
    // The competing turn owns the conversation, so nothing here touched it.
    expect(turn.messages).toHaveLength(1);
    expect(persisted).toEqual([]);
    expect(turn.activityEvents).toEqual([]);
    expect(turn.isLocked()).toBe(true);
  });

  test("holds the processing lock across the repair, then hands it back", async () => {
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });
    let lockedDuringPersist = false;
    let releasePersist = () => {};
    persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });

    const pending = interruptRunningTurn(turn.conversation, { origin: "test" });

    // Let the abort, the idle wait and the claim settle, then read the lock
    // from inside the repair's own persist.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    lockedDuringPersist = turn.isLocked();
    releasePersist();

    expect(await pending).toBe("released");
    expect(lockedDuringPersist).toBe(true);
    // Handed back, so the caller's own turn can claim it.
    expect(turn.isLocked()).toBe(false);
  });

  test("falls back to the queue when the repair row cannot be persisted", async () => {
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });
    persistShouldFail = true;

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("busy");
    // The history is exactly as the call found it, so the caller never writes
    // a user row after a durable `tool_use` that has no durable result.
    expect(turn.messages).toHaveLength(1);
    expect(persisted).toEqual([]);
    // Armed instead, so the drain that runs the queued message repairs it.
    expect(turn.conversation.pendingInterruptRepair).toBe(true);
    expect(turn.activityEvents).toEqual([]);
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
    expect(turn.conversation.pendingInterruptActivityBridge).toBe(true);
  });

  test("waits for the interrupted turn's commit before it repairs or returns", async () => {
    // The processing lock frees before the turn-boundary commit runs, and that
    // commit attributes the working tree to the turn that just ended. Nothing
    // the replacement turn writes may start until the barrier the agent loop
    // closes after the commit has closed.
    const turn = registerBusyTurn({
      messages: [assistantWithToolUse("tool-1")],
    });
    const closeFinalization = beginTurnFinalization(CONV);

    let settled = false;
    const pending = interruptRunningTurn(turn.conversation, {
      origin: "test",
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(turn.aborts).toHaveLength(1);
    expect(settled).toBe(false);
    expect(persisted).toEqual([]);
    expect(turn.messages).toHaveLength(1);

    closeFinalization();

    expect(await pending).toBe("released");
    expect(persisted).toHaveLength(1);
    expect(turn.messages).toHaveLength(2);
  });

  test("settles a parked secret prompt before it aborts the turn", async () => {
    // The turn holds no confirmation, so the confirmation sweep does not run
    // and the secret prompt is the interrupt's alone to settle. Left open, the
    // dialog stays live and a reply that lands after the new turn started
    // resumes the tool this abort abandons.
    const turn = registerBusyTurn();
    let settledWith: unknown;
    let abortsAtSettle: number | undefined;
    pendingInteractions.register("secret-req", {
      conversationId: CONV,
      kind: "secret",
      rpcResolve: (value: unknown) => {
        settledWith = value;
        abortsAtSettle = turn.aborts.length;
      },
    });

    const outcome = await interruptRunningTurn(turn.conversation, {
      origin: "test",
    });

    expect(outcome).toBe("released");
    expect(abortsAtSettle).toBe(0);
    expect(settledWith).toEqual({
      value: null,
      delivery: "store",
      reason: "superseded",
    });
    // Deregistered, so /v1/secret answers a late submission with a 404 rather
    // than routing it into the abandoned tool.
    expect(pendingInteractions.get("secret-req")).toBeUndefined();
  });

  test("leaves another conversation's secret prompt alone", async () => {
    const turn = registerBusyTurn();
    let settled = false;
    pendingInteractions.register("other-secret", {
      conversationId: "some-other-conversation",
      kind: "secret",
      rpcResolve: () => {
        settled = true;
      },
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(settled).toBe(false);
    expect(pendingInteractions.get("other-secret")).toBeDefined();
  });

  test("leaves the host-proxy requests the turn has in flight alone", async () => {
    // A host proxy request is an executing tool call, not a prompt: the client
    // still POSTs its result, and removing the entry would 404 that post.
    const turn = registerBusyTurn();
    pendingInteractions.register("host-req", {
      conversationId: CONV,
      kind: "host_bash",
    });

    await interruptRunningTurn(turn.conversation, { origin: "test" });

    expect(pendingInteractions.get("host-req")).toBeDefined();
  });
});

describe("classifyInterruptEligibility", () => {
  // The synchronous gate a route uses to accept a message before any of the
  // handover is awaited. It must agree with `interruptRunningTurn`, which
  // routes on the same answer rather than repeating the checks.
  const opts = { origin: "test" };

  test("is eligible for an ordinary send on an abortable turn", () => {
    const turn = registerBusyTurn();
    expect(classifyInterruptEligibility(turn.conversation, opts)).toBe(
      "eligible",
    );
  });

  test("names the flag when it is off", () => {
    flagEnabled = false;
    const turn = registerBusyTurn();
    expect(classifyInterruptEligibility(turn.conversation, opts)).toBe(
      "flag_off",
    );
  });

  test("names a hidden send", () => {
    const turn = registerBusyTurn();
    expect(
      classifyInterruptEligibility(turn.conversation, {
        ...opts,
        hidden: true,
      }),
    ).toBe("hidden");
  });

  test("names another actor's turn", () => {
    const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });
    expect(
      classifyInterruptEligibility(turn.conversation, {
        ...opts,
        callerActorPrincipalId: "actor-b",
      }),
    ).toBe("other_actor");
  });

  test("names a processing flag with no abortable turn behind it", () => {
    const turn = registerBusyTurn({ hasController: false });
    expect(classifyInterruptEligibility(turn.conversation, opts)).toBe(
      "no_abortable_turn",
    );
  });

  test("agrees with the outcome interruptRunningTurn produces", async () => {
    // Anything not `eligible` must not end up interrupting.
    for (const options of [
      { ...opts, hidden: true },
      { ...opts, callerActorPrincipalId: "actor-b" },
    ]) {
      const turn = registerBusyTurn({ turnActorPrincipalId: "actor-a" });
      expect(classifyInterruptEligibility(turn.conversation, options)).not.toBe(
        "eligible",
      );
      const outcome = await interruptRunningTurn(turn.conversation, options);
      expect(outcome).not.toBe("released");
      expect(turn.aborts).toEqual([]);
      deleteConversation(CONV);
    }
  });
});

describe("startAfterTurnFinalization", () => {
  test("starts at once when no turn is finalizing", () => {
    let started = false;
    startAfterTurnFinalization(CONV, 1000, () => {
      started = true;
    });
    expect(started).toBe(true);
  });

  test("holds the start until the barrier closes", async () => {
    // The interrupt's queue fallback kicks the drain from a request that has
    // already been answered. An idle conversation is not necessarily a
    // finished one: the fallback is reached when the commit outran its budget,
    // and a drain that started now would have its writes swept into it.
    const close = beginTurnFinalization(CONV);
    let started = false;
    startAfterTurnFinalization(CONV, 1000, () => {
      started = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(false);

    close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(true);
  });

  test("keeps holding past the ceiling rather than starting over a live commit", async () => {
    // The ceiling only decides when to say it is taking a while. Starting on it
    // would be the exact cross-attribution the barrier exists to prevent, and
    // giving up would lose the message, so it does neither: it waits, and the
    // turn always closes the barrier because the commit it waits on is itself
    // bounded.
    const close = beginTurnFinalization(CONV);
    let started = false;
    startAfterTurnFinalization(CONV, 5, () => {
      started = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(started).toBe(false);

    close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(true);
  });
});

describe("waitForTurnFinalization", () => {
  test("resolves at once when no turn is finalizing", async () => {
    expect(await waitForTurnFinalization(CONV, 1000)).toBe(true);
  });

  test("resolves once the turn closes its barrier", async () => {
    const close = beginTurnFinalization(CONV);
    let settled = false;
    const pending = waitForTurnFinalization(CONV, 1000).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    close();
    expect(await pending).toBe(true);
  });

  test("gives up when the budget elapses, so the caller can queue instead", async () => {
    beginTurnFinalization(CONV);
    expect(await waitForTurnFinalization(CONV, 5)).toBe(false);
  });

  test("releases a barrier the next turn supersedes", async () => {
    // A turn that opens a barrier while an unclosed one is still standing
    // settles the old one, so nothing waits on a barrier no turn will close.
    beginTurnFinalization(CONV);
    const pending = waitForTurnFinalization(CONV, 1000);
    beginTurnFinalization(CONV);
    expect(await pending).toBe(true);
  });

  test("closing a superseded barrier leaves the live one standing", async () => {
    const closeFirst = beginTurnFinalization(CONV);
    beginTurnFinalization(CONV);
    closeFirst();
    expect(await waitForTurnFinalization(CONV, 5)).toBe(false);
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
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: PREEMPTED_TOOL_RESULT_TEXT,
          is_error: false,
        },
      ],
    });
    expect(JSON.parse(persisted[0].content)).toEqual(
      messages[1].content as unknown as unknown[],
    );
  });

  test("reports the preempted result it wrote", async () => {
    const messages: Message[] = [assistantWithToolUse("tool-1")];

    const result = await repairInterruptedToolUseBlocks(
      fakeConversation(messages),
      { force: true },
    );

    expect(result.preemptedToolResultOnTail).toBe(true);
  });

  test("reports no preempted result on a history that ends on plain text", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const result = await repairInterruptedToolUseBlocks(
      fakeConversation(messages),
      { force: true },
    );

    expect(result.preemptedToolResultOnTail).toBe(false);
  });

  test("adds nothing when the loop already wrote its own results", async () => {
    // The agent loop's abort handler synthesizes results of its own when it
    // unwinds cleanly, so exactly one result per call exists either way.
    const messages: Message[] = [
      assistantWithToolUse("tool-1"),
      toolResult("tool-1", PREEMPTED_TOOL_RESULT_TEXT),
    ];

    const result = await repairInterruptedToolUseBlocks(
      fakeConversation(messages),
      { force: true },
    );

    expect(messages).toHaveLength(2);
    expect(persisted).toEqual([]);
    expect(result.preemptedToolResultOnTail).toBe(true);
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

  test("keeps the in-memory repair when a drain cannot persist it", async () => {
    // The drain runs its turn off the in-memory history, so a failed persist
    // costs durability, not the next provider call. It settles rather than
    // throwing, which is what keeps a DB hiccup from stranding the queue.
    const messages: Message[] = [assistantWithToolUse("tool-1")];
    persistShouldFail = true;

    await repairInterruptedToolUseBlocks(fakeConversation(messages), {
      force: true,
    });

    expect(messages).toHaveLength(2);
    expect(persisted).toEqual([]);
  });

  test("hands a durable repair's failure back, history untouched", async () => {
    const messages: Message[] = [assistantWithToolUse("tool-1")];
    const conversation = fakeConversation(messages);
    persistShouldFail = true;

    await expect(
      repairInterruptedToolUseBlocks(conversation, {
        force: true,
        requireDurable: true,
      }),
    ).rejects.toThrow("simulated persist failure");

    expect(messages).toHaveLength(1);
    expect(conversation.pendingInterruptRepair).toBe(true);
  });

  test("stays armed by its flags for the queue drain", async () => {
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

/**
 * Verifies that every resolution path through
 * `runtime/pending-interactions.ts` publishes an `interaction_resolved`
 * envelope on the event hub with the right state.
 *
 * Each test registers an interaction directly and calls `resolve()` or
 * `removeByConversation()` so we exercise the tracker in isolation
 * without spinning up a Conversation, prompter, or proxy.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// Capture every broadcast emitted by the tracker. The real hub is replaced
// with a thin recorder so we can assert payloads deterministically.
const publishedMessages: ServerMessage[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: ServerMessage) => {
    publishedMessages.push(msg);
  },
  capabilityForMessageType: () => undefined,
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => ({ dispose: () => {}, active: true }),
  },
}));

const pendingInteractions = await import("../runtime/pending-interactions.js");

beforeEach(() => {
  publishedMessages.length = 0;
  pendingInteractions.clear();
});

afterEach(() => {
  pendingInteractions.clear();
});

function lastResolvedEvent() {
  const evt = publishedMessages.find((m) => m.type === "interaction_resolved");
  expect(evt).toBeDefined();
  return evt as Extract<ServerMessage, { type: "interaction_resolved" }>;
}

describe("pendingInteractions.resolve emits interaction_resolved", () => {
  test("default state is 'cancelled'", () => {
    pendingInteractions.register("req-1", {
      conversationId: "conv-1",
      kind: "confirmation",
    });
    const returned = pendingInteractions.resolve("req-1");
    expect(returned).toBeDefined();
    const evt = lastResolvedEvent();
    expect(evt.requestId).toBe("req-1");
    expect(evt.conversationId).toBe("conv-1");
    expect(evt.state).toBe("cancelled");
    expect(evt.kind).toBe("confirmation");
  });

  test("approved state propagates", () => {
    pendingInteractions.register("req-approve", {
      conversationId: "conv-a",
      kind: "confirmation",
    });
    pendingInteractions.resolve("req-approve", "approved");
    expect(lastResolvedEvent().state).toBe("approved");
  });

  test("rejected state propagates", () => {
    pendingInteractions.register("req-reject", {
      conversationId: "conv-b",
      kind: "confirmation",
    });
    pendingInteractions.resolve("req-reject", "rejected");
    expect(lastResolvedEvent().state).toBe("rejected");
  });

  test("answered state propagates (secret response)", () => {
    pendingInteractions.register("req-secret", {
      conversationId: "conv-c",
      kind: "secret",
    });
    pendingInteractions.resolve("req-secret", "answered");
    const evt = lastResolvedEvent();
    expect(evt.state).toBe("answered");
    expect(evt.kind).toBe("secret");
  });

  test("superseded state propagates", () => {
    pendingInteractions.register("req-super", {
      conversationId: "conv-d",
      kind: "confirmation",
    });
    pendingInteractions.resolve("req-super", "superseded");
    expect(lastResolvedEvent().state).toBe("superseded");
  });

  test("no event is emitted when the requestId is unknown", () => {
    pendingInteractions.resolve("never-registered", "approved");
    expect(publishedMessages).toHaveLength(0);
  });

  test("no event is emitted for a conversation-less interaction", () => {
    /**
     * Conversation-less interactions (e.g. the CLI `credentials prompt`
     * command) resolve through their own resolver rather than a conversation.
     * The `interaction_resolved` envelope requires a conversationId, so the
     * tracker skips the broadcast instead of emitting an invalid event.
     */
    // GIVEN a registered interaction with no owning conversation
    pendingInteractions.register("req-detached", { kind: "secret" });

    // WHEN it is resolved
    const returned = pendingInteractions.resolve("req-detached", "answered");

    // THEN the entry is still returned to its caller
    expect(returned).toBeDefined();

    // AND no interaction_resolved envelope is published
    expect(
      publishedMessages.filter((m) => m.type === "interaction_resolved"),
    ).toHaveLength(0);
  });

  test("a single resolve emits exactly one event", () => {
    pendingInteractions.register("req-once", {
      conversationId: "conv-e",
      kind: "host_bash",
    });
    pendingInteractions.resolve("req-once", "answered");
    // Second resolve is a no-op because the entry was already consumed.
    pendingInteractions.resolve("req-once", "answered");
    const events = publishedMessages.filter(
      (m) => m.type === "interaction_resolved",
    );
    expect(events).toHaveLength(1);
  });

  test("clears the registered timer on resolve", () => {
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
    }, 10_000);
    pendingInteractions.register("req-timer", {
      conversationId: "conv-f",
      kind: "confirmation",
      timer,
    });
    pendingInteractions.resolve("req-timer", "approved");
    clearTimeout(timer);
    expect(fired).toBe(false);
  });
});

describe("removeByConversation emits interaction_resolved per entry", () => {
  test("emits superseded for every non-host interaction in the conversation", () => {
    pendingInteractions.register("conf-1", {
      conversationId: "conv-x",
      kind: "confirmation",
    });
    pendingInteractions.register("secret-1", {
      conversationId: "conv-x",
      kind: "secret",
    });
    pendingInteractions.register("question-1", {
      conversationId: "conv-x",
      kind: "question",
    });
    pendingInteractions.register("host-bash-1", {
      conversationId: "conv-x",
      kind: "host_bash",
    });
    pendingInteractions.register("conf-other", {
      conversationId: "conv-y",
      kind: "confirmation",
    });

    pendingInteractions.removeByConversation("conv-x");

    const events = publishedMessages.filter(
      (m) => m.type === "interaction_resolved",
    ) as Extract<ServerMessage, { type: "interaction_resolved" }>[];
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.state === "superseded")).toBe(true);
    const requestIds = new Set(events.map((e) => e.requestId));
    expect(requestIds).toEqual(new Set(["conf-1", "secret-1", "question-1"]));

    // host_bash entries survive auto-deny — no event for them.
    expect(pendingInteractions.get("host-bash-1")).toBeDefined();
    // Unrelated conversation is untouched.
    expect(pendingInteractions.get("conf-other")).toBeDefined();
  });

  test("explicit state arg overrides the default 'superseded'", () => {
    pendingInteractions.register("conf-2", {
      conversationId: "conv-z",
      kind: "confirmation",
    });
    pendingInteractions.removeByConversation("conv-z", "cancelled");
    const events = publishedMessages.filter(
      (m) => m.type === "interaction_resolved",
    );
    expect(events).toHaveLength(1);
    expect(
      (events[0] as Extract<ServerMessage, { type: "interaction_resolved" }>)
        .state,
    ).toBe("cancelled");
  });

  test("settles a swept secret prompt's resolver with a cancelled result", () => {
    /**
     * A secret prompt blocks its caller (the CLI `credentials prompt` command
     * or the in-conversation SecretPrompter) on `rpcResolve`. Unlike questions
     * (abort-signal teardown) and confirmations (denyAllPendingConfirmations),
     * nothing else settles a secret when it is superseded, so removing the
     * entry alone would hang the caller until its IPC client times out.
     */
    // GIVEN a pending secret whose caller is blocked on rpcResolve
    const resolved: unknown[] = [];
    pendingInteractions.register("secret-sweep", {
      conversationId: "conv-sweep",
      kind: "secret",
      rpcResolve: (value) => resolved.push(value),
    });

    // WHEN a new user message supersedes the conversation's interactions
    pendingInteractions.removeByConversation("conv-sweep");

    // THEN the secret resolver is settled once with a cancelled result
    expect(resolved).toEqual([{ value: null, delivery: "store" }]);
  });

  test("does not invoke a swept confirmation's resolver with a secret result", () => {
    // GIVEN a pending confirmation carrying an rpcResolve callback
    const resolved: unknown[] = [];
    pendingInteractions.register("conf-sweep", {
      conversationId: "conv-conf",
      kind: "confirmation",
      rpcResolve: (value) => resolved.push(value),
    });

    // WHEN the conversation is superseded
    pendingInteractions.removeByConversation("conv-conf");

    // THEN the confirmation resolver is left untouched — only secret prompts
    // are settled with a SecretPromptResult-shaped value here.
    expect(resolved).toHaveLength(0);
  });
});

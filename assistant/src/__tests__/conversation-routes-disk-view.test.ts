import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAssistantMessage } from "../agent/message-types.js";
import type { Conversation } from "../daemon/conversation.js";
import type { EnqueueMessageOptions } from "../daemon/conversation-messaging.js";
import { persistUserMessage } from "../daemon/conversation-messaging.js";
import {
  addMessage,
  findMessageIdByClientMessageId,
  getConversation,
  getMessages as readPersistedMessages,
  provenanceFromTrustContext,
} from "../persistence/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../persistence/conversation-disk-view.js";
import {
  getConversationByKey,
  getOrCreateConversation as getOrCreateConversationMapping,
} from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../runtime/assistant-event-hub.js";
import type { AuthContext } from "../runtime/auth/types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import { callHandler } from "./helpers/call-route-handler.js";
import { setConfig } from "./helpers/set-config.js";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

// Seed the workspace config for real: memory off so `addMessage` (called
// without `skipIndexing` by the fake agent loop) does not index into the
// memory subsystem, and secret detection off to match the prior behavior of
// these route sends.
setConfig("memory", { enabled: false, v2: { enabled: false } });
setConfig("secretDetection", { enabled: false });

await initializeDb();

const conversationInstances = new Map<string, Conversation>();

const authContext: AuthContext = {
  subject: "svc_gateway:self",
  principalType: "svc_gateway",
  assistantId: "self",
  scopeProfile: "gateway_service_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  policyEpoch: 1,
};

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM conversation_keys");
}

function resetConversationsDir(): void {
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
}

function createFakeConversation(conversationId: string): Conversation {
  const conversation = {
    conversationId,
    processing: false,
    currentRequestId: undefined as string | undefined,
    abortController: null as AbortController | null,
    trustContext: undefined as unknown,
    turnChannelContext: null as {
      userMessageChannel: string;
      assistantMessageChannel: string;
    } | null,
    turnInterfaceContext: null as {
      userMessageInterface: string;
      assistantMessageInterface: string;
    } | null,
    messages: [] as Array<unknown>,
    hostCuProxy: undefined as unknown,
    currentTurnSourceActorPrincipalId: undefined as string | undefined,
    pendingSteerRepair: false,
    pendingInterruptRepair: false,
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    /** Polls the flag rather than modelling waiters; the fakes here release
     *  synchronously from their own abort listener. */
    async waitForIdle(
      this: { processing: boolean },
      { timeoutMs }: { timeoutMs: number },
    ) {
      const deadline = Date.now() + Math.min(timeoutMs, 250);
      while (this.processing && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return !this.processing;
    },
    setProcessing(
      this: { processing: boolean; owner: number },
      value: boolean,
    ) {
      this.processing = value;
      this.owner = value ? this.owner + 1 : 0;
    },
    owner: 0,
    async acquireProcessingFenced(this: {
      processing: boolean;
      owner: number;
    }) {
      if (this.processing) {
        return null;
      }
      this.processing = true;
      this.owner += 1;
      return this.owner;
    },
    releaseProcessing(
      this: { processing: boolean; owner: number },
      claim: number,
    ) {
      if (claim !== this.owner) {
        return false;
      }
      this.processing = false;
      this.owner = 0;
      return true;
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext(this: { trustContext: unknown }, ctx: unknown) {
      this.trustContext = ctx;
    },
    setAuthContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext(
      this: {
        turnChannelContext: {
          userMessageChannel: string;
          assistantMessageChannel: string;
        } | null;
      },
      ctx: { userMessageChannel: string; assistantMessageChannel: string },
    ) {
      this.turnChannelContext = ctx;
    },
    getTurnChannelContext(this: {
      turnChannelContext: {
        userMessageChannel: string;
        assistantMessageChannel: string;
      } | null;
    }) {
      return this.turnChannelContext;
    },
    setTurnInterfaceContext(
      this: {
        turnInterfaceContext: {
          userMessageInterface: string;
          assistantMessageInterface: string;
        } | null;
      },
      ctx: {
        userMessageInterface: string;
        assistantMessageInterface: string;
      },
    ) {
      this.turnInterfaceContext = ctx;
    },
    getTurnInterfaceContext(this: {
      turnInterfaceContext: {
        userMessageInterface: string;
        assistantMessageInterface: string;
      } | null;
    }) {
      return this.turnInterfaceContext;
    },
    ensureActorScopedHistory: async () => {},
    replayActivityState: () => {},

    setHostCuProxy(this: { hostCuProxy: unknown }, proxy: unknown) {
      this.hostCuProxy = proxy;
    },
    setHostAppControlProxy(
      this: { hostAppControlProxy: unknown },
      proxy: unknown,
    ) {
      this.hostAppControlProxy = proxy;
    },
    restoreBrowserProxyAvailability: () => {},
    preactivatedSkillIds: undefined as string[] | undefined,
    addPreactivatedSkillId(
      this: { preactivatedSkillIds: string[] | undefined },
      skillId: string,
    ) {
      this.preactivatedSkillIds = [
        ...(this.preactivatedSkillIds ?? []),
        skillId,
      ];
    },
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    enqueueMessage: () => ({ queued: true, requestId: crypto.randomUUID() }),
    kickDrainQueue: async () => {},
    inFlightSendRequestIds: new Map<string, string>(),
    getQueueDepth: () => 0,
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    getMessages(this: { messages: Array<unknown> }) {
      return this.messages as never[];
    },
    persistUserMessage(
      this: Conversation,
      options: Parameters<typeof persistUserMessage>[1],
    ): Promise<{ id: string; deduplicated: boolean }> {
      return persistUserMessage(
        this as Parameters<typeof persistUserMessage>[0],
        options,
      );
    },
    async runAgentLoop(
      this: {
        conversationId: string;
        turnChannelContext: {
          userMessageChannel: string;
          assistantMessageChannel: string;
        } | null;
        turnInterfaceContext: {
          userMessageInterface: string;
          assistantMessageInterface: string;
        } | null;
        trustContext: unknown;
        messages: Array<unknown>;
        processing: boolean;
        abortController: AbortController | null;
        currentRequestId?: string;
      },
      _content: string,
      _userMessageId: string,
      options?: { onEvent?: (msg: Record<string, unknown>) => void },
    ): Promise<void> {
      const onEvent = options?.onEvent ?? (() => {});
      const assistantText = "Synthetic assistant reply";
      const assistantMessage = createAssistantMessage(assistantText);
      const assistantMetadata = {
        ...provenanceFromTrustContext(this.trustContext as never),
        ...(this.turnChannelContext
          ? {
              userMessageChannel: this.turnChannelContext.userMessageChannel,
              assistantMessageChannel:
                this.turnChannelContext.assistantMessageChannel,
            }
          : {}),
        ...(this.turnInterfaceContext
          ? {
              userMessageInterface:
                this.turnInterfaceContext.userMessageInterface,
              assistantMessageInterface:
                this.turnInterfaceContext.assistantMessageInterface,
            }
          : {}),
      };

      const persistedAssistant = await addMessage(
        this.conversationId,
        "assistant",
        JSON.stringify(assistantMessage.content),
        { metadata: assistantMetadata },
      );
      this.messages.push(assistantMessage);

      const conversationRow = getConversation(this.conversationId);
      if (conversationRow) {
        syncMessageToDisk(
          this.conversationId,
          persistedAssistant.id,
          conversationRow.createdAt,
        );
      }

      onEvent({
        type: "assistant_text_delta",
        text: assistantText,
        conversationId: this.conversationId,
      });
      onEvent({
        type: "message_complete",
        conversationId: this.conversationId,
      });

      this.processing = false;
      this.abortController = null;
      this.currentRequestId = undefined;
    },
  };

  return conversation as unknown as Conversation;
}

function getOrCreateFakeConversation(conversationId: string): Conversation {
  const existing = conversationInstances.get(conversationId);
  if (existing) {
    return existing;
  }
  const created = createFakeConversation(conversationId);
  conversationInstances.set(conversationId, created);
  return created;
}

async function waitFor<T>(
  getter: () => T | undefined,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for expected disk-view output");
}

beforeEach(() => {
  resetTables();
  resetConversationsDir();
  conversationInstances.clear();
  pendingInteractions.clear();
});

// ── macOS browser backend fallback regression ─────────────────────────
//
// These tests verify the route-level wiring that enables the CDP factory's
// fallback chain on macOS-originated turns:
//
//   1. Extension connected  → extension backend
//   2. Extension absent, cdp-inspect unavailable → local Playwright fallback
//
// Specifically, we verify that when a macOS message enters through
// handleSendMessage with `interface: "macos"` and NO extension is connected,
// the conversation's turnInterfaceContext is set correctly so the CDP factory
// builds the right candidate list (cdp-inspect → local). If cdp-inspect
// is also unreachable (the common case when Chrome is not launched with
// --remote-debugging-port), the factory falls through to local.
//
// This is the regression guard for backend preference order step 2:
//   macOS + no extension + cdp-inspect unavailable → local backend
//
// If the interface propagation or factory candidate list construction
// regresses, these tests will fail.

describe("macOS browser backend fallback (no extension, no cdp-inspect)", () => {
  test("macOS turn without extension sets turnInterfaceContext to macos, enabling local fallback", async () => {
    const conversationKey = `macos-fallback-${crypto.randomUUID()}`;
    const content = "Test macOS fallback path.";
    let capturedConversation: Conversation | undefined;

    const deps = {
      sendMessageDeps: {
        getOrCreateConversation: async (conversationId: string) => {
          const conv = getOrCreateFakeConversation(conversationId);
          capturedConversation = conv;
          return conv;
        },
        assistantEventHub: new AssistantEventHub(),
        resolveAttachments: () => [],
      },
    };
    const response = await callHandler(
      (args) => handleSendMessage(args, deps),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-principal-type": authContext.principalType,
        },
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "macos",
        }),
      }),
      undefined,
      202,
    );

    expect(response.status).toBe(202);

    // The conversation instance should have its turnInterfaceContext set
    // to "macos" by handleSendMessage. This is the value the CDP factory
    // reads (via ToolContext.transportInterface) to decide whether to
    // include cdp-inspect as a desktop-auto candidate and ultimately fall
    // back to local Playwright when cdp-inspect is unavailable.
    expect(capturedConversation).toBeDefined();
    const interfaceCtx = capturedConversation!.getTurnInterfaceContext();
    expect(interfaceCtx).not.toBeNull();
    expect(interfaceCtx!.userMessageInterface).toBe("macos");
    expect(interfaceCtx!.assistantMessageInterface).toBe("macos");
  });

  test("macOS turn correctly persists interface metadata through the agent loop", async () => {
    const conversationKey = `macos-metadata-${crypto.randomUUID()}`;
    const content = "Verify interface metadata persistence.";

    const response = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async (conversationId: string) =>
              getOrCreateFakeConversation(conversationId),
            assistantEventHub: new AssistantEventHub(),
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-principal-type": authContext.principalType,
        },
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "macos",
        }),
      }),
      undefined,
      202,
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      conversationId: string;
    };

    // Wait for the agent loop to persist the assistant reply (the fake
    // runAgentLoop persists interface metadata into message records).
    const conversationRow = getConversation(body.conversationId);
    expect(conversationRow).not.toBeNull();
    const conversationDir = getConversationDirPath(
      body.conversationId,
      conversationRow!.createdAt,
    );
    const messagesPath = join(conversationDir, "messages.jsonl");

    const lines = await waitFor(() => {
      if (!existsSync(messagesPath)) {
        return undefined;
      }
      const raw = readFileSync(messagesPath, "utf-8").trim();
      if (!raw) {
        return undefined;
      }
      const parsed = raw.split("\n").map(
        (line) =>
          JSON.parse(line) as {
            role: string;
            metadata?: Record<string, unknown>;
          },
      );
      return parsed.length >= 2 ? parsed : undefined;
    });

    // The assistant reply (second line) should carry the interface metadata
    // set by setTurnInterfaceContext during the macOS turn setup.
    const assistantLine = lines[1];
    expect(assistantLine?.role).toBe("assistant");
    expect(assistantLine?.metadata?.userMessageInterface).toBe("macos");
    expect(assistantLine?.metadata?.assistantMessageInterface).toBe("macos");
  });
});

describe("POST /v1/messages — body.conversationId direct id lookup", () => {
  // The handler accepts two scope inputs with distinct semantics:
  //
  //   - `body.conversationId` is the assistant-minted internal id and is
  //     looked up directly. A missing row is a 404 — clients must obtain
  //     the id from a prior daemon response.
  //   - `body.conversationKey` is an external key (non-vellum channels /
  //     web idempotency); resolved via the conversation_keys table and
  //     materialised on first use.
  //
  // When both are sent, `conversationId` wins and `conversationKey` is
  // ignored. (Don't combine — fetch by one and then the other.)

  async function sendMessage(
    body: Record<string, unknown>,
    successStatus = 202,
  ): Promise<Response> {
    return callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async (conversationId: string) =>
              getOrCreateFakeConversation(conversationId),
            assistantEventHub: new AssistantEventHub(),
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-principal-type": authContext.principalType,
        },
        body: JSON.stringify(body),
      }),
      undefined,
      successStatus,
    );
  }

  test("body.conversationId=<existing-id> scopes the send to that conversation", async () => {
    // Pre-materialise a conversation via the key path, then send a message
    // by its assistant-minted internal id.
    const externalKey = `pre-materialised-${crypto.randomUUID()}`;
    const seeded = getOrCreateConversationMapping(externalKey);

    const response = await sendMessage({
      conversationId: seeded.conversationId,
      content: "Direct id lookup — should reuse the existing conversation.",
      sourceChannel: "vellum",
      interface: "macos",
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      conversationId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBe(seeded.conversationId);

    // No new external-key row should be materialised under the internal id.
    expect(getConversationByKey(seeded.conversationId)).toBeNull();
  });

  test("body.conversationId=<non-existent-id> returns 404", async () => {
    const response = await sendMessage(
      {
        conversationId: `does-not-exist-${crypto.randomUUID()}`,
        content: "Should 404 — unknown internal id.",
        sourceChannel: "vellum",
        interface: "macos",
      },
      404,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(body.error?.message).toMatch(/not found/i);
  });

  test("body.conversationId is honored and body.conversationKey is ignored when both are sent", async () => {
    // Seed a conversation for the id we'll send. Also seed a separate
    // conversation under a key the client will pass alongside — but the
    // handler must scope to the id, NOT the key.
    const idSeed = getOrCreateConversationMapping(
      `id-honored-${crypto.randomUUID()}`,
    );
    const keyValue = `key-ignored-${crypto.randomUUID()}`;
    const keySeed = getOrCreateConversationMapping(keyValue);
    expect(idSeed.conversationId).not.toBe(keySeed.conversationId);

    const response = await sendMessage({
      conversationId: idSeed.conversationId,
      conversationKey: keyValue,
      content: "Both fields sent — id should win.",
      sourceChannel: "vellum",
      interface: "macos",
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { conversationId: string };
    expect(body.conversationId).toBe(idSeed.conversationId);
    expect(body.conversationId).not.toBe(keySeed.conversationId);
  });
});

describe("conversationKey send path disk-view regression", () => {
  test("first send on a fresh conversationKey creates disk-view dir and writes user+assistant records", async () => {
    const conversationKey = `fresh-conv-key-${crypto.randomUUID()}`;
    const content = "Please persist this first turn.";

    const response = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async (conversationId: string) =>
              getOrCreateFakeConversation(conversationId),
            assistantEventHub: new AssistantEventHub(),
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-principal-type": authContext.principalType,
        },
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "macos",
        }),
      }),
      undefined,
      202,
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      conversationId: string;
      messageId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBeDefined();
    expect(body.messageId).toBeDefined();

    // Verify the real key store mapping is reused after the first send.
    const mapping = getOrCreateConversationMapping(conversationKey);
    expect(mapping.created).toBe(false);
    expect(mapping.conversationId).toBe(body.conversationId);
    expect(getConversationByKey(conversationKey)?.conversationId).toBe(
      body.conversationId,
    );

    const conversationRow = getConversation(body.conversationId);
    expect(conversationRow).not.toBeNull();
    const conversationDir = getConversationDirPath(
      body.conversationId,
      conversationRow!.createdAt,
    );
    const metaPath = join(conversationDir, "meta.json");
    const messagesPath = join(conversationDir, "messages.jsonl");

    expect(existsSync(conversationDir)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    const lines = await waitFor(() => {
      if (!existsSync(messagesPath)) {
        return undefined;
      }
      const raw = readFileSync(messagesPath, "utf-8").trim();
      if (!raw) {
        return undefined;
      }
      const parsed = raw
        .split("\n")
        .map((line) => JSON.parse(line) as { role: string; content?: string });
      return parsed.length >= 2 ? parsed : undefined;
    });

    expect(lines[0]?.role).toBe("user");
    expect(lines[0]?.content).toBe(content);
    expect(lines[1]?.role).toBe("assistant");
    expect(lines[1]?.content).toBe("Synthetic assistant reply");
  });
});

// A turn clears `preactivatedSkillIds` when it ends, so the per-turn host-proxy
// setup has to run for whichever turn this send actually drives. Under
// `interrupt-on-send` that is a replacement turn on a conversation that was busy
// when the request arrived, and a setup keyed on "was idle on arrival" would
// hand a host-capable macOS client a turn with no `computer-use` or
// `app-control` tools.
describe("host-proxy preactivation across an interrupt", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  /** A conversation mid-turn whose abort releases the lock, as a loop does. */
  function busyConversation(conversationId: string): Conversation {
    const conv = getOrCreateFakeConversation(conversationId) as Conversation & {
      processing: boolean;
      owner: number;
      abortController: AbortController | null;
    };
    conv.processing = true;
    conv.owner = 1;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      conv.processing = false;
      conv.owner = 0;
    });
    conv.abortController = controller;
    return conv;
  }

  async function sendMacosMessage(
    conversationKey: string,
    content: string,
    clientMessageId?: string,
  ) {
    return callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async (conversationId: string) =>
              getOrCreateFakeConversation(conversationId),
            assistantEventHub: new AssistantEventHub(),
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-principal-type": authContext.principalType,
        },
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "macos",
          ...(clientMessageId ? { clientMessageId } : {}),
        }),
      }),
      undefined,
      202,
    );
  }

  test("the replacement turn gets the proxies and the skill preactivation", async () => {
    // `macos` natively supports `host_cu` and `host_app_control`, so the real
    // attachment gate says yes to those two without a connected client to
    // stand in for.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-interrupt-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const conv = busyConversation(conversationId) as Conversation & {
      hostCuProxy?: unknown;
      hostAppControlProxy?: unknown;
      preactivatedSkillIds?: string[];
    };

    const response = await sendMacosMessage(
      conversationKey,
      "stop and tell me the time",
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { queued?: boolean };
    expect(body.queued).toBeUndefined();

    // The response lands before the handover: the abort, the wait for the turn
    // to release and finalize, the repair and the dispatch all run off the
    // request, so the per-turn setup arrives shortly after the 202.
    await waitFor(() =>
      conv.preactivatedSkillIds?.length ? conv.preactivatedSkillIds : undefined,
    );

    // The natively supported capabilities only. `screen-annotation` is absent
    // by design: `host_cu_annotate` is negotiated on a client's connection
    // rather than implied by the interface, and this turn has no connected
    // client advertising it.
    expect(conv.preactivatedSkillIds ?? []).toEqual([
      "computer-use",
      "app-control",
    ]);
    expect(conv.hostCuProxy).toBeDefined();
    expect(conv.hostAppControlProxy).toBeDefined();
  });

  test("answers the request before the handover settles", async () => {
    // `POST /v1/messages` is fire-and-forget. The handover is bounded by the
    // abort budget plus the turn-boundary commit wait, which is far longer than
    // a send may hold a request open, and a client that timed out would retry a
    // message the daemon is still placing. So the abort, the wait, the repair,
    // the persist and the dispatch all run off the response.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-async-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const conv = getOrCreateFakeConversation(conversationId) as Conversation & {
      processing: boolean;
      owner: number;
      abortController: AbortController | null;
    };
    conv.processing = true;
    conv.owner = 1;
    // A turn that does not release on the abort, so the handover is still
    // waiting out its budget when the response has to be back.
    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    conv.abortController = controller;

    const startedAt = Date.now();
    const response = await sendMacosMessage(conversationKey, "stop and answer");
    const elapsedMs = Date.now() - startedAt;

    // The load-bearing assertion. Awaiting the handover would spend the abort
    // release budget here before answering (the fake conversation caps its
    // `waitForIdle` at 250 ms; in production it is `ABORT_RELEASE_WAIT_MS`,
    // 7 s, plus the commit wait). Answering off the handover costs neither.
    expect(elapsedMs).toBeLessThan(100);
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted?: boolean;
      requestId?: string;
      messageId?: string;
      queued?: boolean;
    };
    expect(body.accepted).toBe(true);
    // The id the row will be written with, so the client can correlate.
    expect(typeof body.requestId).toBe("string");
    // And `messageId`, because the response contract is not suspended for an
    // interrupt: `postChatMessage` rejects an accepted, non-queued response
    // without one and the client drops the optimistic row. Same value, since a
    // user turn persists its row under its `requestId`.
    expect(body.messageId).toBe(body.requestId);
    expect(body.queued).toBeUndefined();
    // The conversation is still mid-handover: the turn never released, so the
    // request cannot have waited for it.
    expect(aborted).toBe(true);
    expect(conv.isProcessing()).toBe(true);

    // Let the handover give up and fall back to the queue rather than leaking
    // its timer into the next test.
    conv.processing = false;
    conv.owner = 0;
  });

  test("tells the sender when the queue fallback is rejected after acceptance", async () => {
    // The 202 has already gone out, so `queueSend`'s own 429 answers nobody.
    // Without an event the message is accepted and then silently gone.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-qfull-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const conv = getOrCreateFakeConversation(conversationId) as Conversation & {
      processing: boolean;
      owner: number;
      abortController: AbortController | null;
      enqueueMessage: Conversation["enqueueMessage"];
    };
    conv.processing = true;
    conv.owner = 1;
    // A turn that never releases, so the handover gives up and falls back to
    // the queue, which is full.
    conv.abortController = new AbortController();
    let enqueuedRequestId: string | undefined;
    conv.enqueueMessage = ((options: EnqueueMessageOptions) => {
      enqueuedRequestId = options.requestId;
      // What the real `enqueueMessage` does on a refusal: announce it on the
      // sender's sink as a generic, uncorrelated `queue_full` error. Whether
      // that reaches the wire is the sink's decision, which is what this test
      // is about.
      options.onEvent?.({
        type: "error",
        conversationId,
        message: "The assistant is busy and cannot accept more messages.",
        category: "queue_full",
      });
      return {
        queued: false,
        requestId: options.requestId ?? crypto.randomUUID(),
        rejected: true,
      };
    }) as Conversation["enqueueMessage"];

    const events: Array<Record<string, unknown>> = [];
    const subscription = assistantEventHub.subscribe({
      type: "client",
      clientId: `queue-full-watcher-${crypto.randomUUID()}`,
      interfaceId: "macos",
      capabilities: [],
      callback: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    const response = await sendMacosMessage(conversationKey, "please answer");
    expect(response.status).toBe(202);

    // The hub wraps each event in an envelope; the payload is `message`.
    const accepted = (await response.json()) as { requestId?: string };
    const reported = await waitFor(() => {
      for (const envelope of events) {
        const message = envelope.message as Record<string, unknown> | undefined;
        if (message?.type === "error" && message.code === "QUEUE_FULL") {
          return message;
        }
      }
      return undefined;
    });
    // Correlated by the id the 202 carried, so the client can fail the
    // optimistic row it is already showing and offer the retry. The fallback
    // must not mint an id of its own: the client was told this one.
    expect(reported.requestId).toBe(accepted.requestId);
    expect(reported.category).toBe("queue_drain_failed");
    // And ONLY that one. `enqueueMessage` also announces a refused enqueue as a
    // generic uncorrelated `queue_full` error, which a client reads as the
    // running turn failing and tears that turn down over: a turn this send does
    // not own. It must not reach the wire on a fallback.
    const uncorrelated = events.filter((envelope) => {
      const message = envelope.message as Record<string, unknown> | undefined;
      return message?.type === "error" && message.category === "queue_full";
    });
    expect(uncorrelated).toEqual([]);
    // The fallback enqueue must carry the id the 202 handed out, not one of its
    // own: the row it persists and the queue events it emits are what the
    // client correlates against what it was told.
    expect(enqueuedRequestId).toBe(accepted.requestId);

    subscription.dispose();
    conv.processing = false;
    conv.owner = 0;
  });

  test("disarms the activity bridge when the send starts no turn", async () => {
    // A deduplicated persist answers without starting a loop, and several slash
    // commands do the same. Nothing would consume the armed
    // `message_interrupted` transition on those, so the next ordinary turn on
    // this conversation would emit one belonging to an interrupt long over.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-nobridge-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const clientMessageId = `cmid-${crypto.randomUUID()}`;
    await addMessage(conversationId, "user", "already sent", {
      clientMessageId,
    });
    const conv = getOrCreateFakeConversation(conversationId) as Conversation & {
      pendingInterruptActivityBridge: boolean;
    };
    // Armed as a completed interrupt would leave it, on an idle conversation so
    // the send takes `completeSend` directly and dedups without a turn.
    conv.pendingInterruptActivityBridge = true;

    await sendMacosMessage(conversationKey, "already sent", clientMessageId);

    expect(conv.pendingInterruptActivityBridge).toBe(false);
  });

  test("a retry in the pre-persist window leaves its own turn alone", async () => {
    // A turn arms its abort controller and takes the lock before it inserts its
    // row, so for that window a retry finds a busy conversation and no row. It
    // must not abort there: it would kill the turn its own original request
    // started, then dedup against the row landing a moment later and start
    // nothing, leaving the send answered by neither.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-prepersist-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const clientMessageId = `cmid-${crypto.randomUUID()}`;
    const conv = busyConversation(conversationId) as Conversation & {
      currentTurnClientMessageId?: string;
      currentRequestId?: string;
    };
    // The turn is armed and holding the lock, but its row is not inserted yet.
    conv.currentTurnClientMessageId = clientMessageId;
    conv.currentRequestId = "in-flight-req";
    expect(
      findMessageIdByClientMessageId(conversationId, clientMessageId),
    ).toBeUndefined();

    const response = await sendMacosMessage(
      conversationKey,
      "the original send",
      clientMessageId,
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      queued?: boolean;
      messageId?: string;
      requestId?: string;
    };
    expect(body.queued).toBeUndefined();
    // `messageId` too, or the client rejects the acceptance and drops the
    // optimistic row, which loses the send to its own retry. It is the running
    // turn's request id, which is what that turn persists its row under.
    expect(body.messageId).toBe("in-flight-req");
    expect(body.requestId).toBe("in-flight-req");
    // Untouched: no abort, and the turn still holds the conversation.
    expect(conv.isProcessing()).toBe(true);
  });

  test("reports a queue rejection from inside the detached send too", async () => {
    // `completeSend` has its own queue fallbacks, for losing the lock race
    // after the handover. Running detached, their return value reaches nobody
    // either, so a refused enqueue there has to be reported the same way.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-lockrace-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const conv = busyConversation(conversationId) as Conversation & {
      acquireProcessingFenced: () => Promise<number | null>;
      enqueueMessage: () => {
        queued: boolean;
        requestId: string;
        rejected?: boolean;
      };
    };
    // The handover succeeds (the interrupt takes the lock for its repair and
    // gives it back), then another claim owns the conversation by the time the
    // send tries to take it, and the queue it falls back to is full.
    let claims = 0;
    conv.acquireProcessingFenced = async () => {
      claims += 1;
      return claims === 1 ? 99 : null;
    };
    conv.enqueueMessage = () => ({
      queued: false,
      requestId: crypto.randomUUID(),
      rejected: true,
    });

    const events: Array<Record<string, unknown>> = [];
    const subscription = assistantEventHub.subscribe({
      type: "client",
      clientId: `lock-race-watcher-${crypto.randomUUID()}`,
      interfaceId: "macos",
      capabilities: [],
      callback: (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });

    const response = await sendMacosMessage(
      conversationKey,
      "/definitelynotarealcommand",
    );
    expect(response.status).toBe(202);

    const reported = await waitFor(() => {
      for (const envelope of events) {
        const message = envelope.message as Record<string, unknown> | undefined;
        if (message?.type === "error" && message.code === "QUEUE_FULL") {
          return message;
        }
      }
      return undefined;
    });
    expect(reported.category).toBe("queue_drain_failed");

    subscription.dispose();
  });

  test("a canned slash reply persists under the id the acceptance advertised", async () => {
    // An interrupting send is answered `202` carrying `messageId` before the
    // slash branches run, and those branches persist the user row themselves.
    // Minting an id there would advertise a row that never exists, so the
    // client's optimistic row could never be reconciled against it.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-slash-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    busyConversation(conversationId);

    // `/compact` with an argument is the cheapest route to the canned
    // unknown-command branch, which answers with a card and starts no turn.
    const response = await sendMacosMessage(
      conversationKey,
      "/compact nonsense",
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { messageId?: string };
    expect(typeof body.messageId).toBe("string");

    // The handover and the canned branch both run off the response.
    const row = await waitFor(() =>
      body.messageId
        ? (readPersistedMessages(conversationId).find(
            (m) => m.id === body.messageId,
          ) ?? undefined)
        : undefined,
    );
    expect(row.role).toBe("user");
  });

  test("a retransmit during an accepted handover answers with the first send's id", async () => {
    // The interrupt answers `202` and then does the abort, the waits, the
    // repair and the persist off the response. For that whole stretch a second
    // copy of the same send finds no running turn of its own and no row yet, so
    // without a reservation both would race the unique `clientMessageId` insert
    // and one would lose.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-inflight-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const clientMessageId = `cmid-${crypto.randomUUID()}`;
    const conv = getOrCreateFakeConversation(conversationId) as Conversation & {
      processing: boolean;
      owner: number;
      abortController: AbortController | null;
    };
    conv.processing = true;
    conv.owner = 1;
    // A turn that does not release, so the first send is still mid-handover
    // when the retransmission arrives.
    conv.abortController = new AbortController();

    const first = await sendMacosMessage(
      conversationKey,
      "answer me",
      clientMessageId,
    );
    const firstBody = (await first.json()) as { requestId?: string };
    expect(typeof firstBody.requestId).toBe("string");
    expect(conv.inFlightSendRequestIds.get(clientMessageId)).toBe(
      firstBody.requestId,
    );

    const retry = await sendMacosMessage(
      conversationKey,
      "answer me",
      clientMessageId,
    );
    const retryBody = (await retry.json()) as {
      messageId?: string;
      requestId?: string;
    };

    // The same id both times, so the client's single optimistic row is
    // reconciled against one row rather than two racing inserts.
    expect(retryBody.requestId).toBe(firstBody.requestId);
    expect(retryBody.messageId).toBe(firstBody.requestId);

    conv.processing = false;
    conv.owner = 0;
  });

  test("a retransmit answers with the accepted send's id after the turn releases", async () => {
    // The interrupted turn releases the processing lock partway through the
    // handover, well before `completeSend` writes the row, so a retransmission
    // arriving in that window finds an idle conversation and no row to
    // recognise. Read only on the busy path, the reservation missed it: the
    // retry skipped every duplicate check, started a second `completeSend`, and
    // could win persistence under its own id, leaving the id the first 202
    // advertised naming no row at all.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-released-inflight-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const clientMessageId = `cmid-${crypto.randomUUID()}`;
    const conv = getOrCreateFakeConversation(conversationId);
    const reservedRequestId = crypto.randomUUID();
    conv.inFlightSendRequestIds.set(clientMessageId, reservedRequestId);
    // The lock is already back; the accepted send is still mid-handover.
    expect(conv.isProcessing()).toBe(false);

    const retry = await sendMacosMessage(
      conversationKey,
      "answer me",
      clientMessageId,
    );
    const body = (await retry.json()) as {
      messageId?: string;
      requestId?: string;
    };

    // The id the first 202 advertised, so the client reconciles its single
    // optimistic row against the row that send is about to write.
    expect(body.requestId).toBe(reservedRequestId);
    expect(body.messageId).toBe(reservedRequestId);
    // And nothing of its own: no second row racing the insert, no turn.
    expect(readPersistedMessages(conversationId)).toHaveLength(0);
    expect(conv.isProcessing()).toBe(false);
  });

  test("a retransmitted send answers from the existing row instead of interrupting", async () => {
    // A network retry of an already-accepted POST must not stop the turn its
    // own original request started. The idempotent insert settles duplicates,
    // but it settles them by returning the existing row and exiting without
    // starting a turn, which is too late once the abort has fired: the user's
    // answer would be cancelled for good.
    setOverridesForTesting({ "interrupt-on-send": true });
    const conversationKey = `macos-dup-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const clientMessageId = `cmid-${crypto.randomUUID()}`;
    const existing = await addMessage(
      conversationId,
      "user",
      "the original send",
      {
        clientMessageId,
      },
    );
    const conv = busyConversation(conversationId);

    const response = await sendMacosMessage(
      conversationKey,
      "the original send",
      clientMessageId,
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      messageId?: string;
      queued?: boolean;
    };
    // Answered from the row the first request wrote, and the turn that request
    // started is still running.
    expect(body.messageId).toBe(existing.id);
    expect(body.queued).toBeUndefined();
    expect(conv.isProcessing()).toBe(true);
  });

  test("a send that queues instead leaves the running turn's preactivation alone", async () => {
    // Flag off, so the busy conversation queues. Preactivation belongs to the
    // drain at dequeue time, not to this request.
    setOverridesForTesting({ "interrupt-on-send": false });
    const conversationKey = `macos-queued-${crypto.randomUUID()}`;
    const { conversationId } = getOrCreateConversationMapping(conversationKey);
    const conv = busyConversation(conversationId) as Conversation & {
      preactivatedSkillIds?: string[];
    };

    const response = await sendMacosMessage(conversationKey, "queued instead");

    expect(response.status).toBe(202);
    const body = (await response.json()) as { queued?: boolean };
    expect(body.queued).toBe(true);
    expect(conv.preactivatedSkillIds).toBeUndefined();
  });
});

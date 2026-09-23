/**
 * The shared event stream serves a trusted contact the events of the
 * conversations shared with them, through the real router: membership is read
 * as each event is emitted, only allowlisted event types are carried and each
 * is rebuilt from its known fields, no message content travels, membership
 * changes reach the contact even after the membership is gone, a contact's
 * streams are capped without ever displacing a guardian connection, and a
 * guardian token is refused.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const actualEnv = await import("../../../config/env.js");
mock.module("../../../config/env.js", () => ({
  ...actualEnv,
  isHttpAuthDisabled: () => false,
}));

type Trust = { trustClass: string };
const trusted = async (_principalId: string): Promise<Trust> => ({
  trustClass: "trusted_contact",
});
const resolveSharedPrincipalFresh = mock(trusted);
const resolveSharedPrincipal = mock(trusted);
const actualLookup = await import("../../shared-principal-lookup.js");
mock.module("../../shared-principal-lookup.js", () => ({
  ...actualLookup,
  resolveSharedPrincipalFresh,
  resolveSharedPrincipal,
}));

import type {
  AssistantEvent,
  AssistantEventEnvelope,
} from "../../../api/index.js";
import {
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../../../daemon/message-types/sync.js";
import {
  createConversation,
  deleteConversation,
} from "../../../persistence/conversation-crud.js";
import {
  addParticipant,
  removeParticipant,
} from "../../../persistence/conversation-participants.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { buildAssistantEvent } from "../../assistant-event.js";
import {
  AssistantEventHub,
  assistantEventHub,
} from "../../assistant-event-hub.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext, ScopeProfile } from "../../auth/types.js";
import { HttpRouter } from "../../http-router.js";
import { publishConversationListAndMetadataChanged } from "../../sync/resource-sync-events.js";
import {
  handleSubscribeSharedEvents,
  SHARED_STREAMS_PER_PRINCIPAL,
} from "../events-routes.js";

await initializeDb();

const SECRET = "private text the contact must never see";

function context(principalId: string, scopeProfile: ScopeProfile): AuthContext {
  return {
    subject: `actor:self:${principalId}`,
    principalType: "actor",
    assistantId: "self",
    actorPrincipalId: principalId,
    scopeProfile,
    scopes: resolveScopeProfile(scopeProfile),
    policyEpoch: 0,
  };
}

const ALICE = context("principal-alice", "contact_client_v1");
const GUARDIAN = context("principal-bob", "actor_client_v1");

let server: ReturnType<typeof Bun.serve>;
let router: HttpRouter;
const openStreams: AbortController[] = [];

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  router = new HttpRouter();
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  for (const lookup of [resolveSharedPrincipalFresh, resolveSharedPrincipal]) {
    lookup.mockReset();
    lookup.mockImplementation(trusted);
  }
});

afterEach(() => {
  for (const controller of openStreams.splice(0)) {
    controller.abort();
  }
});

async function dispatch(
  method: string,
  endpoint: string,
  authContext: AuthContext,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  openStreams.push(controller);
  const url = new URL(`http://127.0.0.1/v1/${endpoint}`);
  const req = new Request(url, {
    method,
    headers,
    signal: controller.signal,
  });
  const response = await router.dispatch(
    endpoint,
    req,
    url,
    server,
    authContext,
  );
  if (!response) {
    throw new Error(`no route matched ${method} ${endpoint}`);
  }
  return response;
}

function subscribe(
  authContext: AuthContext,
  headers: Record<string, string> = {},
) {
  return dispatch("GET", "shared/events", authContext, headers);
}

/** A shared stream opened on `hub` directly, bypassing the router. */
function openOnHub(
  hub: AssistantEventHub,
  principalId = "principal-alice",
  heartbeatIntervalMs?: number,
) {
  const controller = new AbortController();
  openStreams.push(controller);
  return frameReader(
    handleSubscribeSharedEvents(
      {
        headers: { "x-vellum-actor-principal-id": principalId },
        abortSignal: controller.signal,
      },
      { hub, heartbeatIntervalMs },
    ),
  );
}

/** Reads SSE frames as they arrive, skipping heartbeats. */
function frameReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<AssistantEventEnvelope> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            return JSON.parse(data.slice("data: ".length));
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("stream closed");
        }
        buffered += decoder.decode(value, { stream: true });
      }
    },
    async closed(): Promise<boolean> {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          return true;
        }
      }
    },
  };
}

async function openStream(authContext: AuthContext = ALICE) {
  const response = await subscribe(authContext);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return frameReader(response.body!);
}

function newConversation(): string {
  return createConversation({ conversationType: "standard" }).id;
}

function share(conversationId: string, principalId = "principal-alice") {
  addParticipant({
    conversationId,
    principalId,
    role: "participant",
    addedBy: "principal-bob",
  });
}

async function emit(
  message: AssistantEvent,
  conversationId?: string,
  hub: AssistantEventHub = assistantEventHub,
) {
  await hub.publish(buildAssistantEvent(message, conversationId));
}

function messagesChanged(...conversationIds: string[]): AssistantEvent {
  return {
    type: "sync_changed",
    tags: conversationIds.map(conversationMessagesSyncTag),
  };
}

function membershipChanged(conversationId: string): AssistantEvent {
  return {
    type: "sync_changed",
    tags: [
      SYNC_TAGS.sharedConversationsList,
      conversationMetadataSyncTag(conversationId),
    ],
  };
}

/** A frame the contact receives, published last so everything before it has been decided. */
async function emitMarker(conversationId: string, title: string) {
  await emit(
    { type: "conversation_title_updated", conversationId, title },
    conversationId,
  );
}

describe("GET shared/events", () => {
  test("carries a member conversation's invalidations and nothing for another", async () => {
    const shared = newConversation();
    const unshared = newConversation();
    const carols = newConversation();
    share(shared);
    share(carols, "principal-carol");
    const stream = await openStream();

    await emit(messagesChanged(unshared));
    await emit(messagesChanged(carols));
    await emit(messagesChanged(shared));

    const frame = await stream.next();
    expect(frame.conversationId).toBe(shared);
    expect(frame.message).toEqual({
      type: "sync_changed",
      tags: [conversationMessagesSyncTag(shared)],
    });
    expect(frame.seq).toBeUndefined();
  });

  test("splits a mixed invalidation into the caller's conversations only", async () => {
    const first = newConversation();
    const second = newConversation();
    const unshared = newConversation();
    share(first);
    share(second);
    const stream = await openStream();

    await emit({
      type: "sync_changed",
      tags: [
        "conversations:list",
        conversationMessagesSyncTag(unshared),
        conversationMessagesSyncTag(first),
        conversationMetadataSyncTag(first),
        conversationMetadataSyncTag(second),
        "assistant:self:config",
      ],
      originClientId: "guardian-device",
    });

    const frames = [await stream.next(), await stream.next()];
    expect(frames.map((f) => [f.conversationId, f.message])).toEqual([
      [
        first,
        {
          type: "sync_changed",
          tags: [
            conversationMessagesSyncTag(first),
            conversationMetadataSyncTag(first),
          ],
        },
      ],
      [
        second,
        {
          type: "sync_changed",
          tags: [conversationMetadataSyncTag(second)],
        },
      ],
    ]);
  });

  test("a conversation shared mid-stream starts delivering without a reconnect", async () => {
    const conversationId = newConversation();
    const stream = await openStream();

    await emit(messagesChanged(conversationId));
    share(conversationId);
    await emitMarker(conversationId, "Now shared");

    const joined = await stream.next();
    expect(joined.conversationId).toBe(conversationId);
    expect(joined.message).toEqual(membershipChanged(conversationId));
    expect((await stream.next()).message).toEqual({
      type: "conversation_title_updated",
      conversationId,
      title: "Now shared",
    });
  });

  test("a removed participant stops receiving without a reconnect", async () => {
    const removed = newConversation();
    const kept = newConversation();
    share(removed);
    share(kept);
    const stream = await openStream();

    await emitMarker(removed, "Before removal");
    expect((await stream.next()).conversationId).toBe(removed);

    removeParticipant(removed, "principal-alice");
    await emit(messagesChanged(removed));
    await emit(messagesChanged(removed));
    await emitMarker(removed, "After removal");
    await emitMarker(kept, "Still shared");

    const left = await stream.next();
    expect(left.conversationId).toBe(removed);
    expect(left.message).toEqual(membershipChanged(removed));
    const frame = await stream.next();
    expect(frame.conversationId).toBe(kept);
    expect(frame.message).toMatchObject({ title: "Still shared" });
  });

  test("the participant removal route reaches the removed contact", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const stream = await openStream();

    const response = await dispatch(
      "DELETE",
      `conversations/${conversationId}/participants/principal-alice`,
      GUARDIAN,
    );
    expect(response.status).toBe(204);

    const frame = await stream.next();
    expect(frame.conversationId).toBe(conversationId);
    expect(frame.message).toEqual(membershipChanged(conversationId));
  });

  test("deleting a shared conversation reaches its contact", async () => {
    const deleted = newConversation();
    const kept = newConversation();
    share(deleted);
    share(kept);
    const stream = await openStream();

    deleteConversation(deleted);
    publishConversationListAndMetadataChanged("deleted", deleted);

    const frame = await stream.next();
    expect(frame.conversationId).toBe(deleted);
    expect(frame.message).toEqual(membershipChanged(deleted));
  });

  test("a membership change for a conversation never shared is not announced", async () => {
    const neverShared = newConversation();
    const shared = newConversation();
    share(shared);
    const stream = await openStream();

    deleteConversation(neverShared);
    publishConversationListAndMetadataChanged("deleted", neverShared);
    await emitMarker(shared, "Marker");

    expect((await stream.next()).message).toMatchObject({ title: "Marker" });
  });

  test("drops every event type outside the allowlist", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const stream = await openStream();

    const dropped: AssistantEvent[] = [
      { type: "assistant_text_delta", text: SECRET, conversationId },
      { type: "assistant_thinking_delta", thinking: SECRET, conversationId },
      { type: "message_complete", messageId: "msg-1", conversationId },
      {
        type: "user_message_echo",
        text: SECRET,
        conversationId,
        messageId: "msg-2",
      },
      {
        type: "tool_use_start",
        toolName: "bash",
        input: { command: SECRET },
        conversationId,
      },
      {
        type: "tool_result",
        toolName: "bash",
        result: SECRET,
        conversationId,
      } as AssistantEvent,
      {
        type: "confirmation_request",
        requestId: "req-1",
        toolName: "bash",
        input: { command: SECRET },
        riskLevel: "high",
        allowlistOptions: [],
        scopeOptions: [],
        conversationId,
      } as AssistantEvent,
      { type: "generation_cancelled", conversationId },
      { type: "config_changed" },
    ];
    for (const message of dropped) {
      await emit(message, conversationId);
    }
    await emit({ type: "config_changed" });
    await emit({ type: "sync_changed", tags: ["conversations:list"] });
    await emitMarker(conversationId, "Marker");

    const frame = await stream.next();
    expect(frame.message).toMatchObject({
      type: "conversation_title_updated",
      title: "Marker",
    });
  });

  test("rebuilds activity state without its status text or request id", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const stream = await openStream();

    await emit(
      {
        type: "assistant_activity_state",
        conversationId,
        activityVersion: 3,
        phase: "tool_running",
        anchor: "assistant_turn",
        reason: "tool_use_start",
        requestId: "req-1",
        statusText: `Reading ${SECRET}`,
      },
      conversationId,
    );

    const frame = await stream.next();
    expect(frame.message).toEqual({
      type: "assistant_activity_state",
      conversationId,
      activityVersion: 3,
      phase: "tool_running",
      anchor: "assistant_turn",
      reason: "tool_use_start",
    });
    expect(JSON.stringify(frame)).not.toContain(SECRET);
  });

  test("drops an event whose envelope and payload name different conversations", async () => {
    const shared = newConversation();
    const unshared = newConversation();
    share(shared);
    const stream = await openStream();

    await emit(
      {
        type: "conversation_title_updated",
        conversationId: unshared,
        title: SECRET,
      },
      shared,
    );
    await emitMarker(shared, "Marker");

    expect((await stream.next()).message).toMatchObject({ title: "Marker" });
  });

  test("never registers the contact as a client", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const response = await subscribe(ALICE, {
      "x-vellum-client-id": "guardian-device",
      "x-vellum-interface-id": "macos",
    });
    expect(response.status).toBe(200);
    const stream = frameReader(response.body!);

    expect(
      assistantEventHub
        .listClients()
        .some((client) => client.clientId === "guardian-device"),
    ).toBe(false);

    await emitMarker(conversationId, "Marker");
    expect((await stream.next()).message).toMatchObject({ title: "Marker" });
  });
});

describe("connection limits", () => {
  function guardianClient(hub: AssistantEventHub, clientId: string) {
    return hub.subscribe({
      type: "client",
      clientId,
      interfaceId: "macos",
      capabilities: [],
      callback: () => {},
    });
  }

  test("contact streams never evict a guardian subscriber", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    const guardian = guardianClient(hub, "guardian-mac");

    for (const principalId of ["principal-alice", "principal-carol"]) {
      for (let i = 0; i < 10; i++) {
        openOnHub(hub, principalId);
      }
    }

    expect(guardian.active).toBe(true);
    expect(hub.subscriberCount()).toBe(1 + 2 * SHARED_STREAMS_PER_PRINCIPAL);
  });

  test("a guardian subscriber at the hub cap evicts only another guardian subscriber", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 2 });
    for (let i = 0; i < SHARED_STREAMS_PER_PRINCIPAL; i++) {
      openOnHub(hub);
    }
    const first = guardianClient(hub, "guardian-mac");
    const second = guardianClient(hub, "guardian-phone");
    expect(first.active).toBe(true);

    const third = guardianClient(hub, "guardian-web");

    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    expect(third.active).toBe(true);
    expect(hub.subscriberCount()).toBe(2 + SHARED_STREAMS_PER_PRINCIPAL);
  });

  test("a contact over the per-principal cap loses their own oldest stream", async () => {
    const hub = new AssistantEventHub();
    const carols = openOnHub(hub, "principal-carol");
    const alices = Array.from(
      { length: SHARED_STREAMS_PER_PRINCIPAL + 1 },
      () => openOnHub(hub),
    );

    expect(await alices[0]!.closed()).toBe(true);
    expect(hub.subscriberCount()).toBe(SHARED_STREAMS_PER_PRINCIPAL + 1);

    const conversationId = newConversation();
    share(conversationId, "principal-carol");
    await emit(
      {
        type: "conversation_title_updated",
        conversationId,
        title: "For Carol",
      },
      conversationId,
      hub,
    );
    expect((await carols.next()).message).toEqual(
      membershipChanged(conversationId),
    );
  });
});

describe("trust enforcement", () => {
  test("a guardian token is refused, even as a participant", async () => {
    share(newConversation(), "principal-bob");
    const response = await subscribe(GUARDIAN);
    expect(response.status).toBe(404);
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });

  test.each(["unverified_contact", "unknown", "guardian"])(
    "a contact resolving %s is refused",
    async (trustClass) => {
      resolveSharedPrincipalFresh.mockImplementation(async () => ({
        trustClass,
      }));
      const response = await subscribe(ALICE);
      expect(response.status).toBe(404);
    },
  );

  test("a contact revoked mid-stream has the stream closed", async () => {
    const hub = new AssistantEventHub();
    const conversationId = newConversation();
    share(conversationId);
    const stream = openOnHub(hub, "principal-alice", 5);

    await emit(
      {
        type: "conversation_title_updated",
        conversationId,
        title: "Before revoke",
      },
      conversationId,
      hub,
    );
    expect((await stream.next()).message).toMatchObject({
      title: "Before revoke",
    });

    resolveSharedPrincipal.mockImplementation(async () => ({
      trustClass: "unknown",
    }));
    expect(await stream.closed()).toBe(true);
    expect(hub.subscriberCount()).toBe(0);
    expect(resolveSharedPrincipal).toHaveBeenCalledWith("principal-alice");
  });

  test("a request without a principal is refused", () => {
    expect(() => handleSubscribeSharedEvents({ headers: {} })).toThrow(
      "Not found",
    );
  });
});

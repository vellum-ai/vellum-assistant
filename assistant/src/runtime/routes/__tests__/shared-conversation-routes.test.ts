/**
 * The shared read routes serve a trusted contact the conversations they
 * participate in, through the real router: membership decides every answer,
 * a miss is a 404 indistinguishable from an unknown id, messages are the
 * contact projection with empty rows omitted, and a guardian token is
 * refused on all three.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

const actualEnv = await import("../../../config/env.js");
mock.module("../../../config/env.js", () => ({
  ...actualEnv,
  isHttpAuthDisabled: () => false,
}));

type Trust = { trustClass: string };
const resolveSharedPrincipalFresh = mock(
  async (_principalId: string): Promise<Trust> => ({
    trustClass: "trusted_contact",
  }),
);
const actualLookup = await import("../../shared-principal-lookup.js");
mock.module("../../shared-principal-lookup.js", () => ({
  ...actualLookup,
  resolveSharedPrincipalFresh,
}));

import { routeDefinitionsToIpcMethods } from "../../../ipc/routes/route-adapter.js";
import {
  addMessage,
  createConversation,
} from "../../../persistence/conversation-crud.js";
import {
  addParticipant,
  removeParticipant,
} from "../../../persistence/conversation-participants.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { messages } from "../../../persistence/schema/index.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext, ScopeProfile } from "../../auth/types.js";
import { HttpRouter } from "../../http-router.js";
import { ROUTES } from "../shared-conversation-routes.js";

await initializeDb();

const UNKNOWN_CONVERSATION = "123e4567-e89b-42d3-a456-426614174000";
const REASONING = "private reasoning the contact must never see";

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
const CAROL = context("principal-carol", "contact_client_v1");
const GUARDIAN = context("principal-bob", "actor_client_v1");

let server: ReturnType<typeof Bun.serve>;
let router: HttpRouter;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  router = new HttpRouter();
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  resolveSharedPrincipalFresh.mockReset();
  resolveSharedPrincipalFresh.mockImplementation(async () => ({
    trustClass: "trusted_contact",
  }));
});

async function call(endpoint: string, authContext: AuthContext) {
  const url = new URL(`http://127.0.0.1/v1/${endpoint}`);
  const req = new Request(url, { method: "GET" });
  const response = await router.dispatch(
    url.pathname.slice("/v1/".length),
    req,
    url,
    server,
    authContext,
  );
  if (!response) {
    throw new Error(`no route matched GET ${endpoint}`);
  }
  return response;
}

async function ok<T>(endpoint: string, authContext: AuthContext = ALICE) {
  const response = await call(endpoint, authContext);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function newConversation(title?: string): string {
  return createConversation({ conversationType: "standard", title }).id;
}

function share(conversationId: string, principalId = "principal-alice") {
  addParticipant({
    conversationId,
    principalId,
    role: "participant",
    addedBy: "principal-bob",
  });
}

let clock = 1_700_000_000_000;

async function write(
  conversationId: string,
  role: "user" | "assistant",
  content: unknown[],
  metadata?: Record<string, unknown>,
): Promise<string> {
  const row = await addMessage(conversationId, role, JSON.stringify(content), {
    metadata,
    skipIndexing: true,
  });
  clock += 1000;
  getDb()
    .update(messages)
    .set({ createdAt: clock })
    .where(eq(messages.id, row.id))
    .run();
  return row.id;
}

const text = (value: string) => ({ type: "text", text: value });

interface SharedConversation {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

interface MessagesPage {
  messages: {
    id: string;
    role: string;
    createdAt: number;
    content: { type: string; text?: string }[];
  }[];
  hasMore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: string | null;
}

const SHARED_CONVERSATION_KEYS = [
  "createdAt",
  "id",
  "lastMessageAt",
  "title",
  "updatedAt",
];

describe("GET shared/conversations", () => {
  test("lists only the caller's live shared conversations", async () => {
    const shared = newConversation("Trip plans");
    const removed = newConversation();
    const unshared = newConversation();
    const carols = newConversation();
    share(shared);
    share(removed);
    removeParticipant(removed, "principal-alice");
    share(carols, "principal-carol");

    const { conversations } = await ok<{
      conversations: SharedConversation[];
    }>("shared/conversations");

    const ids = conversations.map((c) => c.id);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(removed);
    expect(ids).not.toContain(unshared);
    expect(ids).not.toContain(carols);
    const entry = conversations.find((c) => c.id === shared)!;
    expect(Object.keys(entry).sort()).toEqual(SHARED_CONVERSATION_KEYS);
    expect(entry.title).toBe("Trip plans");
  });
});

describe("GET shared/conversations/:id", () => {
  test("returns allowlisted metadata to a participant", async () => {
    const conversationId = newConversation("Groceries");
    share(conversationId);

    const { conversation } = await ok<{ conversation: SharedConversation }>(
      `shared/conversations/${conversationId}`,
    );

    expect(Object.keys(conversation).sort()).toEqual(SHARED_CONVERSATION_KEYS);
    expect(conversation).toMatchObject({
      id: conversationId,
      title: "Groceries",
    });
  });
});

describe("GET shared/conversations/:id/messages", () => {
  test("returns projected messages and omits rows that project to nothing", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const question = await write(conversationId, "user", [
      text("What should we cook?"),
    ]);
    const answer = await write(conversationId, "assistant", [
      { type: "thinking", thinking: REASONING, signature: "sig" },
      text("Pasta."),
      { type: "tool_use", id: "tool-1", name: "bash", input: { cmd: "ls" } },
    ]);
    await write(conversationId, "user", [
      { type: "tool_result", tool_use_id: "tool-1", content: "secret.txt" },
    ]);
    await write(conversationId, "assistant", [
      { type: "redacted_thinking", data: REASONING },
    ]);
    await write(conversationId, "user", [text("hidden scaffolding")], {
      hidden: true,
    });
    await write(conversationId, "assistant", [text("Only for Carol.")], {
      audience: { kind: "oneReader", userId: "principal-carol" },
    });

    const page = await ok<MessagesPage>(
      `shared/conversations/${conversationId}/messages`,
    );

    expect(page.messages).toEqual([
      {
        id: question,
        role: "user",
        createdAt: expect.any(Number),
        content: [text("What should we cook?")],
      },
      {
        id: answer,
        role: "assistant",
        createdAt: expect.any(Number),
        content: [text("Pasta.")],
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.oldestMessageId).toBe(question);

    const serialized = JSON.stringify(page);
    for (const leaked of [
      REASONING,
      "thinking",
      "tool_use",
      "tool_result",
      "secret.txt",
      "hidden scaffolding",
      "Only for Carol.",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  test("the addressee of a restricted reply reads it", async () => {
    const conversationId = newConversation();
    share(conversationId);
    share(conversationId, "principal-carol");
    await write(conversationId, "assistant", [text("Only for Carol.")], {
      audience: { kind: "oneReader", userId: "principal-carol" },
    });

    const forCarol = await ok<MessagesPage>(
      `shared/conversations/${conversationId}/messages`,
      CAROL,
    );
    const forAlice = await ok<MessagesPage>(
      `shared/conversations/${conversationId}/messages`,
    );

    expect(forCarol.messages.map((m) => m.content)).toEqual([
      [text("Only for Carol.")],
    ]);
    expect(forAlice.messages).toEqual([]);
  });

  test("pages over visible rows only", async () => {
    const conversationId = newConversation();
    share(conversationId);
    const visible: string[] = [];
    for (let i = 0; i < 5; i++) {
      visible.push(await write(conversationId, "user", [text(`message ${i}`)]));
      await write(conversationId, "assistant", [
        { type: "thinking", thinking: REASONING, signature: "sig" },
      ]);
    }
    const base = `shared/conversations/${conversationId}/messages`;

    const newest = await ok<MessagesPage>(`${base}?limit=2`);
    expect(newest.messages.map((m) => m.id)).toEqual(visible.slice(3));
    expect(newest.hasMore).toBe(true);
    expect(newest.oldestMessageId).toBe(visible[3]);

    const older = await ok<MessagesPage>(
      `${base}?limit=2&beforeTimestamp=${newest.oldestTimestamp}`,
    );
    expect(older.messages.map((m) => m.id)).toEqual(visible.slice(1, 3));
    expect(older.hasMore).toBe(true);

    const oldest = await ok<MessagesPage>(
      `${base}?limit=2&beforeTimestamp=${older.oldestTimestamp}`,
    );
    expect(oldest.messages.map((m) => m.id)).toEqual(visible.slice(0, 1));
    expect(oldest.hasMore).toBe(false);
  });

  test("an invalid limit on a shared conversation is a 400", async () => {
    const conversationId = newConversation();
    share(conversationId);

    const response = await call(
      `shared/conversations/${conversationId}/messages?limit=many`,
      ALICE,
    );
    expect(response.status).toBe(400);
  });
});

describe("membership", () => {
  async function expectNotFound(conversationId: string, query = "") {
    for (const endpoint of [
      `shared/conversations/${conversationId}`,
      `shared/conversations/${conversationId}/messages${query}`,
    ]) {
      const response = await call(endpoint, ALICE);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
    }
  }

  test("a conversation not shared with the caller is a 404", async () => {
    const conversationId = newConversation();
    await write(conversationId, "user", [text("guardian only")]);
    await expectNotFound(conversationId);
  });

  test("a conversation shared with someone else is a 404", async () => {
    const conversationId = newConversation();
    share(conversationId, "principal-carol");
    await expectNotFound(conversationId);
  });

  test("a participant who was removed gets a 404", async () => {
    const conversationId = newConversation();
    share(conversationId);
    removeParticipant(conversationId, "principal-alice");
    await expectNotFound(conversationId);
  });

  test("an unknown conversation id is the same 404", async () => {
    await expectNotFound(UNKNOWN_CONVERSATION);
  });

  test("membership is checked before the query is validated", async () => {
    const conversationId = newConversation();
    await expectNotFound(conversationId, "?limit=many");
  });
});

describe("trust enforcement", () => {
  const endpoints = (conversationId: string) => [
    "shared/conversations",
    `shared/conversations/${conversationId}`,
    `shared/conversations/${conversationId}/messages`,
  ];

  test("a guardian token is refused on every route, even as a participant", async () => {
    const conversationId = newConversation();
    share(conversationId, "principal-bob");

    for (const endpoint of endpoints(conversationId)) {
      const response = await call(endpoint, GUARDIAN);
      expect(response.status).toBe(404);
    }
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });

  test.each(["unverified_contact", "unknown", "guardian"])(
    "a contact resolving %s is refused on every route",
    async (trustClass) => {
      resolveSharedPrincipalFresh.mockImplementation(async () => ({
        trustClass,
      }));
      const conversationId = newConversation();
      share(conversationId);

      for (const endpoint of endpoints(conversationId)) {
        const response = await call(endpoint, ALICE);
        expect(response.status).toBe(404);
      }
    },
  );

  test("the IPC route schema admits only a trusted contact holding shared.read", async () => {
    const schemaRoute = routeDefinitionsToIpcMethods(ROUTES).find(
      (route) => route.operationId === "get_route_schema",
    )!;
    const schema = (await schemaRoute.handler({})) as {
      operationId: string;
      policy: {
        requiredScopes: string[];
        allowedPrincipalTypes: string[];
        allowedTrustClasses: string[];
      } | null;
    }[];

    expect(schema.map((entry) => entry.operationId).sort()).toEqual(
      ROUTES.map((route) => route.operationId).sort(),
    );
    for (const entry of schema) {
      expect(entry.policy).toEqual({
        requiredScopes: ["shared.read"],
        allowedPrincipalTypes: ["actor"],
        allowedTrustClasses: ["trusted_contact"],
      });
    }
  });

  test("over IPC the caller is the principal the gateway forwards", async () => {
    const conversationId = newConversation("Over IPC");
    share(conversationId);
    const route = routeDefinitionsToIpcMethods(ROUTES).find(
      (r) => r.operationId === "getSharedConversation",
    )!;

    const forAlice = (await route.handler({
      pathParams: { id: conversationId },
      headers: { "x-vellum-actor-principal-id": "principal-alice" },
    })) as { conversation: SharedConversation };
    expect(forAlice.conversation.title).toBe("Over IPC");

    expect(() =>
      route.handler({
        pathParams: { id: conversationId },
        headers: { "x-vellum-actor-principal-id": "principal-carol" },
      }),
    ).toThrow("Conversation not found");
  });
});

/**
 * The participant routes list, add, and remove the principals a conversation
 * is shared with, refuse a principal without an active contact, and are
 * served only to the guardian: a contact-role token gets 404 from the real
 * router on every one of them.
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

const publishSyncInvalidation = mock(
  async (_tags: string[], _originClientId?: string) => {},
);
mock.module("../../sync/sync-publisher.js", () => ({
  publishSyncInvalidation,
}));

import { routeDefinitionsToIpcMethods } from "../../../ipc/routes/route-adapter.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { isParticipant } from "../../../persistence/conversation-participants.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext, ScopeProfile } from "../../auth/types.js";
import { HttpRouter } from "../../http-router.js";
import { ROUTES } from "../conversation-participant-routes.js";

await initializeDb();

const UNKNOWN_CONVERSATION = "123e4567-e89b-42d3-a456-426614174000";

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

const GUARDIAN = context("principal-bob", "actor_client_v1");
const CONTACT = context("principal-alice", "contact_client_v1");

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
  publishSyncInvalidation.mockClear();
});

async function call(
  method: string,
  endpoint: string,
  authContext: AuthContext,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://127.0.0.1/v1/${endpoint}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

function newConversation(): string {
  return createConversation({ conversationType: "standard" }).id;
}

async function share(conversationId: string, principalId: string) {
  return call(
    "POST",
    `conversations/${conversationId}/participants`,
    GUARDIAN,
    {
      principalId,
    },
  );
}

async function list(conversationId: string) {
  const response = await call(
    "GET",
    `conversations/${conversationId}/participants`,
    GUARDIAN,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { participants: unknown[] }).participants;
}

describe("guardian", () => {
  test("shares a conversation with an active contact", async () => {
    const conversationId = newConversation();

    const response = await share(conversationId, "principal-alice");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { participant: unknown };
    expect(body.participant).toMatchObject({
      principalId: "principal-alice",
      role: "participant",
      addedBy: "principal-bob",
    });
    expect(resolveSharedPrincipalFresh).toHaveBeenCalledWith("principal-alice");
    expect(await list(conversationId)).toEqual([body.participant]);
    expect(publishSyncInvalidation).toHaveBeenCalledWith(
      [`conversation:${conversationId}:metadata`],
      undefined,
    );
  });

  test("sharing twice keeps the first entry", async () => {
    const conversationId = newConversation();
    const first = await (await share(conversationId, "principal-alice")).json();
    const second = await (
      await share(conversationId, "principal-alice")
    ).json();

    expect(second).toEqual(first);
    expect(await list(conversationId)).toHaveLength(1);
  });

  test.each(["unknown", "unverified_contact", "guardian"])(
    "refuses a principal resolving %s",
    async (trustClass) => {
      resolveSharedPrincipalFresh.mockImplementation(async () => ({
        trustClass,
      }));
      const conversationId = newConversation();

      const response = await share(conversationId, "principal-alice");

      expect(response.status).toBe(422);
      expect(isParticipant(conversationId, "principal-alice")).toBe(false);
      expect(publishSyncInvalidation).not.toHaveBeenCalled();
    },
  );

  test("refuses a contact revoked since it was last shared with", async () => {
    const first = newConversation();
    expect((await share(first, "principal-alice")).status).toBe(200);

    resolveSharedPrincipalFresh.mockImplementation(async () => ({
      trustClass: "unknown",
    }));
    const second = newConversation();
    expect((await share(second, "principal-alice")).status).toBe(422);
    expect(isParticipant(second, "principal-alice")).toBe(false);
  });

  test("a missing principalId is a 400", async () => {
    const conversationId = newConversation();
    const response = await call(
      "POST",
      `conversations/${conversationId}/participants`,
      GUARDIAN,
      { principalId: "  " },
    );

    expect(response.status).toBe(400);
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });

  test("removes a participant", async () => {
    const conversationId = newConversation();
    await share(conversationId, "principal-alice");
    publishSyncInvalidation.mockClear();

    const path = `conversations/${conversationId}/participants/principal-alice`;
    const response = await call("DELETE", path, GUARDIAN);

    expect(response.status).toBe(204);
    expect(await list(conversationId)).toEqual([]);
    expect(publishSyncInvalidation).toHaveBeenCalledTimes(1);
    expect((await call("DELETE", path, GUARDIAN)).status).toBe(404);
  });

  test("an unknown conversation is a 404 on every route", async () => {
    const base = `conversations/${UNKNOWN_CONVERSATION}/participants`;

    expect((await call("GET", base, GUARDIAN)).status).toBe(404);
    expect(
      (await call("POST", base, GUARDIAN, { principalId: "principal-alice" }))
        .status,
    ).toBe(404);
    expect(
      (await call("DELETE", `${base}/principal-alice`, GUARDIAN)).status,
    ).toBe(404);
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });
});

describe("contact", () => {
  test("gets 404 from every participant route, and changes nothing", async () => {
    const conversationId = newConversation();
    await share(conversationId, "principal-alice");
    resolveSharedPrincipalFresh.mockClear();
    publishSyncInvalidation.mockClear();
    const base = `conversations/${conversationId}/participants`;

    const responses = [
      await call("GET", base, CONTACT),
      await call("POST", base, CONTACT, { principalId: "principal-carol" }),
      await call("DELETE", `${base}/principal-alice`, CONTACT),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    }
    expect(isParticipant(conversationId, "principal-alice")).toBe(true);
    expect(isParticipant(conversationId, "principal-carol")).toBe(false);
    expect(publishSyncInvalidation).not.toHaveBeenCalled();
  });

  test("the IPC route schema admits only the guardian", async () => {
    const schemaRoute = routeDefinitionsToIpcMethods(ROUTES).find(
      (route) => route.operationId === "get_route_schema",
    )!;
    const schema = (await schemaRoute.handler({})) as {
      operationId: string;
      policy: { allowedTrustClasses: string[] } | null;
    }[];

    expect(schema.map((entry) => entry.operationId).sort()).toEqual(
      ROUTES.map((route) => route.operationId).sort(),
    );
    for (const entry of schema) {
      expect(entry.policy?.allowedTrustClasses).toEqual(["guardian"]);
    }
  });
});

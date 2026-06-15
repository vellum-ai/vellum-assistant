import { describe, expect, test } from "bun:test";

import { z } from "zod";

import type { RouteContext } from "../http-router.js";
import { routeDefinitionsToHTTPRoutes } from "./http-adapter.js";
import type { RouteDefinition } from "./types.js";

/**
 * Builds a minimal RouteContext for testing the adapter's body-parsing path.
 * Fields unused by the validation logic (`server`, `authContext`, `params`)
 * are stubbed with safe defaults.
 */
function jsonContext(body: unknown, method = "POST"): RouteContext {
  const url = new URL("http://localhost/test");
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    req,
    url,
    server: {} as RouteContext["server"],
    params: {},
    authContext: {
      subject: "test",
      principalType: "local",
      assistantId: "test-assistant",
      scopeProfile: "local_v1",
      scopes: new Set(),
      policyEpoch: 0,
    },
  };
}

function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    operationId: "test_op",
    endpoint: "test",
    method: "POST",
    policy: null,
    handler: ({ body }) => ({ received: body }),
    ...overrides,
  };
}

describe("http-adapter request body validation", () => {
  test("valid body passes through to handler", async () => {
    const schema = z.object({ name: z.string() });
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({ requestBody: schema }),
    ]);
    const response = await adapted.handler(jsonContext({ name: "alice" }));
    expect(response).toBeInstanceOf(Response);
    const json = await (response as Response).json();
    expect(json).toEqual({ received: { name: "alice" } });
  });

  test("invalid body returns 400 with issue details", async () => {
    const schema = z.object({
      name: z.string(),
      mode: z.enum(["fast", "slow"]),
    });
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({ requestBody: schema }),
    ]);
    const response = await adapted.handler(
      jsonContext({ name: 123, mode: "turbo" }),
    );
    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("BAD_REQUEST");
    expect(json.error.message).toContain("Invalid request body");
    expect(json.error.message).toContain("name");
    expect(json.error.message).toContain("mode");
  });

  test("handler receives parsed (coerced) output, not raw input", async () => {
    const schema = z
      .object({
        count: z.number().default(10),
        label: z.string(),
      })
      .passthrough();
    let handlerBody: unknown;
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({
        requestBody: schema,
        handler: ({ body }) => {
          handlerBody = body;
          return { ok: true };
        },
      }),
    ]);
    await adapted.handler(jsonContext({ label: "test" }));
    expect(handlerBody).toEqual({ label: "test", count: 10 });
  });

  test("no validation when requestBody is not declared", async () => {
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({ requestBody: undefined }),
    ]);
    const response = await adapted.handler(jsonContext({ anything: "goes" }));
    expect(response).toBeInstanceOf(Response);
    const json = await (response as Response).json();
    expect(json).toEqual({ received: { anything: "goes" } });
  });

  test("no validation for non-JSON body (contentType/schema form)", async () => {
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({
        requestBody: {
          contentType: "application/octet-stream",
          schema: { type: "string", format: "binary" },
        },
      }),
    ]);
    const response = await adapted.handler(jsonContext({ unexpected: "json" }));
    expect(response).toBeInstanceOf(Response);
    const json = await (response as Response).json();
    expect(json).toEqual({ received: { unexpected: "json" } });
  });

  test("no validation when body is undefined (GET request)", async () => {
    const schema = z.object({ name: z.string() });
    let handlerCalled = false;
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({
        method: "GET",
        requestBody: schema,
        handler: () => {
          handlerCalled = true;
          return { ok: true };
        },
      }),
    ]);
    const url = new URL("http://localhost/test");
    const req = new Request(url, { method: "GET" });
    await adapted.handler({
      req,
      url,
      server: {} as RouteContext["server"],
      params: {},
      authContext: {
        subject: "test",
        principalType: "local",
        assistantId: "test-assistant",
        scopeProfile: "local_v1",
        scopes: new Set(),
        policyEpoch: 0,
      },
    });
    expect(handlerCalled).toBe(true);
  });

  test(".passthrough() schema preserves extra fields", async () => {
    const schema = z.object({ name: z.string() }).passthrough();
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({ requestBody: schema }),
    ]);
    const response = await adapted.handler(
      jsonContext({ name: "alice", extra: "field" }),
    );
    const json = await (response as Response).json();
    expect(json).toEqual({ received: { name: "alice", extra: "field" } });
  });

  test("strict schema rejects extra fields", async () => {
    const schema = z.object({ name: z.string() }).strict();
    const [adapted] = routeDefinitionsToHTTPRoutes([
      makeRoute({ requestBody: schema }),
    ]);
    const response = await adapted.handler(
      jsonContext({ name: "alice", extra: "field" }),
    );
    const res = response as Response;
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("BAD_REQUEST");
    expect(json.error.message).toContain("Invalid request body");
  });
});

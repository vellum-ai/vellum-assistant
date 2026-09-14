/**
 * The `notices/` sub-namespace of a plugin's routes belongs to the gateway.
 *
 * The gateway posts its admission-denied notice there and the plugin acts on
 * it with its own vendor credentials, without running a turn. An actor client
 * reaching the same path could hand the plugin a forged notice, so the runtime
 * serves the prefix to the gateway's service principal only, ahead of the
 * `x/:path*` catch-all that every other plugin route is served through. These
 * tests drive the real router with real auth contexts so the ordering, not
 * just the declared policy, is what is proved.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

import { PLUGIN_ADMISSION_DENIED_NOTICE_PATH } from "@vellumai/gateway-client";

// Route policies are only evaluated when HTTP auth is on.
const actualEnv = await import("../../../config/env.js");
mock.module("../../../config/env.js", () => ({
  ...actualEnv,
  isHttpAuthDisabled: () => false,
}));

import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { resolveScopeProfile } from "../../auth/scopes.js";
import type { AuthContext, ScopeProfile } from "../../auth/types.js";
import { HttpRouter } from "../../http-router.js";
import type { RouteHandlerArgs, RouteResponse } from "../types.js";
import { ROUTES } from "../user-routes.js";

const PLUGIN = "echo-plugin";
const NOTICE_ENDPOINT = `x/plugins/${PLUGIN}/${PLUGIN_ADMISSION_DENIED_NOTICE_PATH}`;
const NOTICE_ROOT_ENDPOINT = `x/plugins/${PLUGIN}/notices`;
const SIBLING_ENDPOINT = `x/plugins/${PLUGIN}/status`;
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const ECHO_HANDLER = `
function echo(request) {
  return Response.json({
    pathname: new URL(request.url).pathname,
    principalType: request.headers.get("x-vellum-principal-type"),
  });
}
export const GET = echo;
export const POST = echo;
export const PUT = echo;
export const PATCH = echo;
export const DELETE = echo;
`;

interface EchoBody {
  pathname: string;
  principalType: string | null;
}

function context(
  principalType: AuthContext["principalType"],
  scopeProfile: ScopeProfile,
): AuthContext {
  return {
    subject: `${principalType}:self:test`,
    principalType,
    assistantId: "self",
    actorPrincipalId: principalType === "actor" ? "user-123" : undefined,
    scopeProfile,
    scopes: resolveScopeProfile(scopeProfile),
    policyEpoch: 0,
  };
}

const ACTOR = context("actor", "actor_client_v1");
const GATEWAY = context("svc_gateway", "gateway_service_v1");
const LOCAL = context("local", "local_v1");

let server: ReturnType<typeof Bun.serve>;
let router: HttpRouter;

beforeAll(() => {
  // The router's dispatch signature carries the Bun server for WebSocket
  // upgrades; user routes never touch it.
  server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  router = new HttpRouter();
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  const routesDir = join(getWorkspacePluginsDir(), PLUGIN, "routes");
  mkdirSync(join(routesDir, "notices"), { recursive: true });
  writeFileSync(
    join(routesDir, "notices", "admission-denied.ts"),
    ECHO_HANDLER,
  );
  writeFileSync(join(routesDir, "notices", "index.ts"), ECHO_HANDLER);
  writeFileSync(join(routesDir, "status.ts"), ECHO_HANDLER);
});

afterEach(() => {
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
});

async function dispatch(
  method: string,
  endpoint: string,
  authContext: AuthContext,
): Promise<Response> {
  const url = new URL(`http://127.0.0.1/v1/${endpoint}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : "{}",
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

describe("plugin notice routes", () => {
  test("an actor client cannot post a notice", async () => {
    const response = await dispatch("POST", NOTICE_ENDPOINT, ACTOR);
    expect(response.status).toBe(403);
  });

  test("a local caller cannot post a notice either", async () => {
    const response = await dispatch("POST", NOTICE_ENDPOINT, LOCAL);
    expect(response.status).toBe(403);
  });

  test("the reservation covers every method under the prefix", async () => {
    for (const method of METHODS) {
      const response = await dispatch(method, NOTICE_ENDPOINT, ACTOR);
      expect(response.status).toBe(403);
    }
  });

  test("the namespace root is reserved too", async () => {
    // `routes/notices/index.ts` is a handler at `notices`, which no catch-all
    // param can match, so it has its own definition. The trailing-slash
    // spelling normalizes to the same endpoint.
    expect((await dispatch("POST", NOTICE_ROOT_ENDPOINT, ACTOR)).status).toBe(
      403,
    );
    expect(
      (await dispatch("POST", `${NOTICE_ROOT_ENDPOINT}/`, ACTOR)).status,
    ).toBe(403);
    const response = await dispatch("POST", NOTICE_ROOT_ENDPOINT, GATEWAY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as EchoBody;
    expect(body.principalType).toBe("svc_gateway");
  });

  test("a respelled path does not reach the handler through the catch-all", async () => {
    // The notice definitions match literal segments on the wire spelling;
    // the catch-all decodes and the filesystem folds, so each of these would
    // otherwise resolve to `notices/admission-denied.ts` under the actor
    // policy.
    const respellings = [
      `x/plugins/${PLUGIN}/%6eotices/admission-denied`,
      `x/%70lugins/${PLUGIN}/notices/admission-denied`,
      `x/plugins/${PLUGIN}//notices/admission-denied`,
      `x/plugins/${PLUGIN}/./notices/admission-denied`,
      `x/plugins/${PLUGIN}/Notices/admission-denied`,
      `x/plugins/${PLUGIN}/%6eotices`,
    ];
    for (const endpoint of respellings) {
      const response = await dispatch("POST", endpoint, ACTOR);
      expect(response.status).toBe(403);
    }
  });

  test("a respelling of an ordinary plugin route still serves", async () => {
    // The refusal is about the namespace, not about encoding in general.
    const response = await dispatch(
      "POST",
      `x/plugins/${PLUGIN}/%73tatus`,
      ACTOR,
    );
    expect(response.status).toBe(200);
  });

  test("the gateway's service principal reaches the plugin's handler", async () => {
    const response = await dispatch("POST", NOTICE_ENDPOINT, GATEWAY);
    expect(response.status).toBe(200);
    const body = (await response.json()) as EchoBody;
    expect(body.principalType).toBe("svc_gateway");
    expect(body.pathname).toBe(`/v1/${NOTICE_ENDPOINT}`);
  });

  test("the rest of the plugin's namespace still serves actor clients", async () => {
    const response = await dispatch("POST", SIBLING_ENDPOINT, ACTOR);
    expect(response.status).toBe(200);
    const body = (await response.json()) as EchoBody;
    expect(body.principalType).toBe("actor");
    expect(body.pathname).toBe(`/v1/${SIBLING_ENDPOINT}`);
  });

  test("served over IPC, the handler sees the full plugin path", async () => {
    // No wire URL on that transport: the route rebuilds it from the params
    // it matched, and the plugin segment has to survive the rebuild.
    const route = ROUTES.find(
      (r) => r.operationId === "plugin_notice_route_post",
    )!;
    const handler = route.handler as (
      args: RouteHandlerArgs,
    ) => Promise<RouteResponse>;
    const response = await handler({
      pathParams: {
        plugin: PLUGIN,
        path: PLUGIN_ADMISSION_DENIED_NOTICE_PATH.slice("notices/".length),
      },
      headers: { "x-vellum-principal-type": "svc_gateway" },
      body: {},
    });
    expect(response.status).toBe(200);
    const body = (await new Response(response.body).json()) as EchoBody;
    expect(body.pathname).toBe(`/v1/${NOTICE_ENDPOINT}`);
    expect(body.principalType).toBe("svc_gateway");
  });
});

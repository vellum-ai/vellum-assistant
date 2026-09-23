/**
 * The router refuses a contact-role token on every route that does not admit
 * its trust class, with a 404, and leaves every other token untouched.
 *
 * The real route table is served with stub handlers, so each route's own
 * endpoint and policy are what is exercised without running its handler. A
 * probe route that opts into contacts covers the admitted path, which no
 * shipped route takes yet.
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

let authDisabled = false;
const actualEnv = await import("../../config/env.js");
mock.module("../../config/env.js", () => ({
  ...actualEnv,
  isHttpAuthDisabled: () => authDisabled,
}));

type Trust = { trustClass: string };
const resolveSharedPrincipalFresh = mock(
  async (_principalId: string): Promise<Trust> => ({
    trustClass: "trusted_contact",
  }),
);
const actualLookup = await import("../shared-principal-lookup.js");
mock.module("../shared-principal-lookup.js", () => ({
  ...actualLookup,
  resolveSharedPrincipalFresh,
}));

const { isContactTrustClass } = await import("../trust-class.js");
const { CONTACT_ALLOWED, enforcePolicy } =
  await import("../auth/route-policy.js");
const actualRoutes = await import("../routes/index.js");
type RouteDefinition = (typeof actualRoutes.ROUTES)[number];

let reached: string | undefined;
const stub = (route: RouteDefinition): RouteDefinition => ({
  ...route,
  requireGuardian: false,
  handler: () => {
    reached = route.operationId;
    return { ok: true };
  },
});

const PROBE: RouteDefinition = {
  operationId: "trust_probe",
  endpoint: "trust-probe",
  method: "POST",
  policy: {
    requiredScopes: ["chat.write"],
    allowedPrincipalTypes: ["actor"],
    allowedTrustClasses: CONTACT_ALLOWED,
  },
  handler: () => ({ ok: true }),
};

const REAL_ROUTES = actualRoutes.ROUTES.map(stub);
const GUARDIAN_ROUTES = REAL_ROUTES.filter(
  (route) => !route.policy?.allowedTrustClasses?.some(isContactTrustClass),
);
mock.module("../routes/index.js", () => ({
  ...actualRoutes,
  ROUTES: [...REAL_ROUTES, stub(PROBE)],
}));

const { resolveScopeProfile } = await import("../auth/scopes.js");
const { HttpRouter } = await import("../http-router.js");
import type { AuthContext, ScopeProfile } from "../auth/types.js";

function context(
  subject: string,
  scopeProfile: ScopeProfile,
  principalType: AuthContext["principalType"] = "actor",
): AuthContext {
  const actorPrincipalId =
    principalType === "actor" ? subject.split(":")[2] : undefined;
  return {
    subject,
    principalType,
    assistantId: "self",
    actorPrincipalId,
    scopeProfile,
    scopes: resolveScopeProfile(scopeProfile),
    policyEpoch: 0,
  };
}

const CONTACT = context("actor:self:principal-alice", "contact_client_v1");
const GUARDIAN = context("actor:self:principal-bob", "actor_client_v1");
const GATEWAY = context(
  "svc:gateway:self",
  "gateway_service_v1",
  "svc_gateway",
);
const LOCAL = context("local:self:conv-xyz", "local_v1", "local");

const UUID = "123e4567-e89b-42d3-a456-426614174000";

/** A concrete path for a route's endpoint pattern. */
function concretePath(route: RouteDefinition): string {
  const types = new Map(
    (route.pathParams ?? []).map((param) => [param.name, param.type]),
  );
  return route.endpoint
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment;
      }
      if (segment.endsWith("*")) {
        return "a/b";
      }
      return types.get(segment.slice(1)) === "uuid" ? UUID : "x";
    })
    .join("/");
}

let server: ReturnType<typeof Bun.serve>;
let router: InstanceType<typeof HttpRouter>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  router = new HttpRouter();
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  authDisabled = false;
  reached = undefined;
  resolveSharedPrincipalFresh.mockReset();
  resolveSharedPrincipalFresh.mockImplementation(async () => ({
    trustClass: "trusted_contact",
  }));
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

describe("contact-role tokens", () => {
  test("POST /v1/messages is a 404", async () => {
    const response = await dispatch("POST", "messages", CONTACT);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(reached).toBeUndefined();
  });

  test("every route not admitting contacts is a 404, without a trust lookup", async () => {
    expect(GUARDIAN_ROUTES.length).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const route of GUARDIAN_ROUTES) {
      reached = undefined;
      const response = await dispatch(
        route.method,
        concretePath(route),
        CONTACT,
      );
      if (response.status !== 404 || reached !== undefined) {
        leaks.push(`${route.method} ${route.endpoint}: ${response.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });

  test("a malformed path on a guardian route is a 404, not a 400", async () => {
    const route = GUARDIAN_ROUTES.find(
      (r) => r.endpoint.includes(":") && !r.pathParams?.length,
    )!;
    const path = route.endpoint.replace(/:[^/]+/, "a%zz");

    expect((await dispatch(route.method, path, CONTACT)).status).toBe(404);
    expect((await dispatch(route.method, path, GUARDIAN)).status).toBe(400);
  });

  test("an unrecognized profile is trust-checked too", async () => {
    const response = await dispatch(
      "POST",
      "messages",
      context("actor:self:principal-alice", "bogus_v1" as ScopeProfile),
    );
    expect(response.status).toBe(404);
    expect(reached).toBeUndefined();
  });

  test("refusal holds under the dev auth bypass", async () => {
    authDisabled = true;
    const response = await dispatch("POST", "messages", CONTACT);
    expect(response.status).toBe(404);
    expect(reached).toBeUndefined();
  });

  test.each(["trusted_contact", "unverified_contact"])(
    "a route admitting contacts serves a %s",
    async (trustClass) => {
      resolveSharedPrincipalFresh.mockImplementation(async () => ({
        trustClass,
      }));
      const response = await dispatch("POST", "trust-probe", CONTACT);

      expect(response.status).toBe(200);
      expect(reached).toBe("trust_probe");
      expect(resolveSharedPrincipalFresh).toHaveBeenCalledWith(
        "principal-alice",
      );
    },
  );

  test.each(["unknown", "guardian"])(
    "a route admitting contacts refuses a principal resolving %s",
    async (trustClass) => {
      resolveSharedPrincipalFresh.mockImplementation(async () => ({
        trustClass,
      }));
      const response = await dispatch("POST", "trust-probe", CONTACT);

      expect(response.status).toBe(404);
      expect(reached).toBeUndefined();
    },
  );

  test("a revoked contact is refused on its next request", async () => {
    expect((await dispatch("POST", "trust-probe", CONTACT)).status).toBe(200);

    resolveSharedPrincipalFresh.mockImplementation(async () => ({
      trustClass: "unknown",
    }));
    reached = undefined;
    expect((await dispatch("POST", "trust-probe", CONTACT)).status).toBe(404);
    expect(reached).toBeUndefined();
    expect(resolveSharedPrincipalFresh).toHaveBeenCalledTimes(2);
  });

  test("a failed trust lookup refuses", async () => {
    resolveSharedPrincipalFresh.mockImplementation(async () => {
      throw new Error("gateway unreachable");
    });
    const response = await dispatch("POST", "trust-probe", CONTACT);

    expect(response.status).toBe(404);
    expect(reached).toBeUndefined();
  });

  test("a contact token naming no actor principal refuses without a lookup", async () => {
    const response = await dispatch(
      "POST",
      "trust-probe",
      context("svc:gateway:self", "contact_client_v1", "svc_gateway"),
    );

    expect(response.status).toBe(404);
    expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
  });
});

describe("other tokens", () => {
  test("a guardian token reaches POST /v1/messages", async () => {
    const response = await dispatch("POST", "messages", GUARDIAN);

    expect(response.status).toBe(202);
    expect(reached).toBe("messages_post");
  });

  test.each([
    ["guardian", GUARDIAN],
    ["svc_gateway", GATEWAY],
    ["local", LOCAL],
  ] as const)(
    "a %s token gets what the scope policy alone decides on every route",
    async (_label, ctx) => {
      const drift: string[] = [];
      for (const route of REAL_ROUTES) {
        reached = undefined;
        const response = await dispatch(route.method, concretePath(route), ctx);
        const denied = enforcePolicy(route.endpoint, route.policy, ctx);
        const expected = denied ? denied.status : route.operationId;
        const actual = reached ?? response.status;
        if (actual !== expected) {
          drift.push(`${route.method} ${route.endpoint}: ${actual}`);
        }
      }
      expect(drift).toEqual([]);
      expect(resolveSharedPrincipalFresh).not.toHaveBeenCalled();
    },
  );
});

/**
 * Unit tests for sanity-routes.ts.
 *
 * Drives the handler functions directly (bypassing the router) and mocks
 * out secure-keys, the node:fs writes, and fetch so no real I/O occurs.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the module under test
// ---------------------------------------------------------------------------

let storedToken: string | undefined = undefined;

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (_key: string) => storedToken,
}));

const FAKE_WORKSPACE = "/tmp/sanity-routes-test-workspace";

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => FAKE_WORKSPACE,
}));

const writtenFiles = new Map<string, string>();

mock.module("node:fs", () => ({
  mkdirSync: () => {},
  writeFileSync: (path: string, content: string) => {
    writtenFiles.set(path, content);
  },
  // Expose the rest of node:fs unchanged so other imports still work.
  // Bun's mock.module replaces only what we return, and the module under
  // test only imports mkdirSync and writeFileSync from node:fs.
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ROUTES } from "../sanity-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function makeArgs(body?: Record<string, unknown>): RouteHandlerArgs {
  return { body };
}

const discoverHandler = findHandler("sanity_discover");
const connectHandler = findHandler("sanity_connect");

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchReturn = { status: number; json: () => unknown };
let mockFetchImpl: ((url: string) => FetchReturn) | undefined = undefined;

const originalFetch = globalThis.fetch;

function mockFetch(url: string | URL | Request): Promise<Response> {
  const urlStr =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!mockFetchImpl) throw new Error(`Unexpected fetch: ${urlStr}`);
  const result = mockFetchImpl(urlStr);
  return Promise.resolve({
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.json(),
  } as Response);
}

beforeEach(() => {
  writtenFiles.clear();
  storedToken = undefined;
  mockFetchImpl = undefined;

  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — no stored token
// ---------------------------------------------------------------------------

describe("sanity_discover — no stored token", () => {
  test("returns { error: 'no_token' } when token absent", async () => {
    storedToken = undefined;
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "no_token" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — project listing
// ---------------------------------------------------------------------------

describe("sanity_discover — list projects", () => {
  beforeEach(() => {
    storedToken = "sk-test-token";
  });

  test("returns projects when API responds 200", async () => {
    mockFetchImpl = () => ({
      status: 200,
      json: () => [
        { id: "proj-a", displayName: "Project Alpha" },
        { id: "proj-b", displayName: "Project Beta" },
      ],
    });

    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({
      projects: [
        { id: "proj-a", displayName: "Project Alpha" },
        { id: "proj-b", displayName: "Project Beta" },
      ],
    });
  });

  test("returns { error: 'token_scope_limited' } on 401", async () => {
    mockFetchImpl = () => ({ status: 401, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'token_scope_limited' } on 403", async () => {
    mockFetchImpl = () => ({ status: 403, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'discovery_failed' } on 500", async () => {
    mockFetchImpl = () => ({ status: 500, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "discovery_failed" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — dataset listing (projectId provided)
// ---------------------------------------------------------------------------

describe("sanity_discover — list datasets", () => {
  beforeEach(() => {
    storedToken = "sk-test-token";
  });

  test("returns datasets when API responds 200", async () => {
    mockFetchImpl = (url) => {
      expect(url).toContain("/projects/my-project/datasets");
      return {
        status: 200,
        json: () => [{ name: "production" }, { name: "staging" }],
      };
    };

    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({
      projectId: "my-project",
      datasets: ["production", "staging"],
    });
  });

  test("returns { error: 'token_scope_limited' } on 403 for dataset list", async () => {
    mockFetchImpl = () => ({ status: 403, json: () => ({}) });
    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'discovery_failed' } on 500 for dataset list", async () => {
    mockFetchImpl = () => ({ status: 500, json: () => ({}) });
    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({ error: "discovery_failed" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/connect
// ---------------------------------------------------------------------------

describe("sanity_connect", () => {
  test("writes sidecar when token present and inputs valid", async () => {
    storedToken = "sk-test-token";

    const result = await connectHandler(
      makeArgs({ projectId: "my-proj", dataset: "production" }),
    );

    expect(result).toEqual({ ok: true });

    const expectedPath = `${FAKE_WORKSPACE}/data/sanity-connection.json`;
    expect(writtenFiles.has(expectedPath)).toBe(true);
    const written = JSON.parse(writtenFiles.get(expectedPath)!);
    expect(written).toEqual({ projectId: "my-proj", dataset: "production" });
  });

  test("throws when no token is stored", async () => {
    storedToken = undefined;

    expect(
      connectHandler(makeArgs({ projectId: "p", dataset: "production" })),
    ).rejects.toThrow();
  });

  test("throws when projectId is empty", async () => {
    storedToken = "sk-test-token";

    expect(
      connectHandler(makeArgs({ projectId: "  ", dataset: "production" })),
    ).rejects.toThrow();
  });

  test("throws when dataset is empty", async () => {
    storedToken = "sk-test-token";

    expect(
      connectHandler(makeArgs({ projectId: "my-proj", dataset: "" })),
    ).rejects.toThrow();
  });

  test("does not return token in response", async () => {
    storedToken = "sk-super-secret";

    const result = (await connectHandler(
      makeArgs({ projectId: "p", dataset: "d" }),
    )) as Record<string, unknown>;

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("sk-super-secret");
  });
});

// ---------------------------------------------------------------------------
// Route policy verification
// ---------------------------------------------------------------------------

describe("route policies", () => {
  test("sanity_discover requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "sanity_discover");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });

  test("sanity_connect requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "sanity_connect");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });
});

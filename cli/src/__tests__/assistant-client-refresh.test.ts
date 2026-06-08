/**
 * Tests for AssistantClient's reactive 401 -> refresh -> retry: a paired/local
 * guardian access token that 401s is refreshed once via the stored refresh
 * credential and the request retried. Self-gating (no refresh token => no
 * retry) and never applied to the platform session-auth path.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "client-refresh-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_FETCH = globalThis.fetch;

import { AssistantClient } from "../lib/assistant-client.js";
import { saveAssistantEntry } from "../lib/assistant-config.js";
import { loadGuardianToken, saveGuardianToken } from "../lib/guardian-token.js";

const RUNTIME = "https://gw.example.com";
const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

function seedPaired(refreshToken: string): void {
  saveAssistantEntry({
    assistantId: "px",
    name: "Paired",
    runtimeUrl: RUNTIME,
    cloud: "paired",
    paired: true,
    species: "vellum",
  });
  saveGuardianToken("px", {
    guardianPrincipalId: "imported",
    accessToken: "old-acc",
    accessTokenExpiresAt: FUTURE,
    refreshToken,
    refreshTokenExpiresAt: refreshToken ? FUTURE : 0,
    refreshAfter: "",
    isNew: false,
    deviceId: "dev",
    leasedAt: new Date().toISOString(),
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with a URL-routed stub; returns the call log. */
function stubFetch(handler: (url: string, calls: Call[]) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(url, calls);
  }) as typeof fetch;
  return calls;
}

const isRefresh = (url: string) => url.includes("/v1/guardian/refresh");

function refreshResponse(): Response {
  return new Response(
    JSON.stringify({
      accessToken: "new-acc",
      refreshToken: "new-ref",
      accessTokenExpiresAt: FUTURE,
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: "",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("AssistantClient 401 -> refresh -> retry", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_CONFIG_HOME = testDir;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("refreshes and retries once on 401, persisting the new token", async () => {
    seedPaired("refresh-tok");
    let assistantAttempts = 0;
    const calls = stubFetch((url) => {
      if (isRefresh(url)) return refreshResponse();
      assistantAttempts++;
      return new Response("", { status: assistantAttempts === 1 ? 401 : 200 });
    });

    const client = new AssistantClient({ assistantId: "px" });
    const res = await client.get("/messages/");

    expect(res.status).toBe(200);
    expect(assistantAttempts).toBe(2); // original + one retry
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(1);
    // The retry carried the refreshed bearer token.
    const assistantCalls = calls.filter((c) => !isRefresh(c.url));
    expect(assistantCalls[1].headers["Authorization"]).toBe("Bearer new-acc");
    // refreshGuardianToken persisted the rotated token.
    expect(loadGuardianToken("px")?.accessToken).toBe("new-acc");
  });

  test("does not retry when there is no stored refresh token", async () => {
    seedPaired(""); // access-only
    let assistantAttempts = 0;
    const calls = stubFetch((url) => {
      if (isRefresh(url)) return refreshResponse();
      assistantAttempts++;
      return new Response("", { status: 401 });
    });

    const client = new AssistantClient({ assistantId: "px" });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(1); // no retry
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(0);
  });

  test("never refreshes on the platform session-auth path", async () => {
    seedPaired("refresh-tok"); // entry must exist; session auth ignores it
    let assistantAttempts = 0;
    const calls = stubFetch((url) => {
      if (isRefresh(url)) return refreshResponse();
      assistantAttempts++;
      return new Response("", { status: 401 });
    });

    const client = new AssistantClient({
      assistantId: "px",
      sessionToken: "sess-tok",
      orgId: "org-1",
    });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(1);
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(0);
  });

  test("retries at most once (second 401 is not refreshed again)", async () => {
    seedPaired("refresh-tok");
    let assistantAttempts = 0;
    const calls = stubFetch((url) => {
      if (isRefresh(url)) return refreshResponse();
      assistantAttempts++;
      return new Response("", { status: 401 }); // always 401
    });

    const client = new AssistantClient({ assistantId: "px" });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(2); // original + one retry, no more
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(1);
  });
});

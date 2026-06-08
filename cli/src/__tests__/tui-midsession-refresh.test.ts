/**
 * Tests for maybeRefreshAuthHeaders: the TUI's mid-session 401 -> refresh of a
 * PAIRED assistant's guardian token, mutating the shared auth headers in place.
 * Scoped to cloud:"paired"; skips local/docker, platform session auth, ephemeral
 * --token, and access-only tokens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ENV = process.env.VELLUM_ENVIRONMENT;
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_FETCH = globalThis.fetch;

import { maybeRefreshAuthHeaders } from "../components/DefaultMainScreen";
import { saveAssistantEntry } from "../lib/assistant-config";
import { saveGuardianToken } from "../lib/guardian-token";

const RUNTIME = "https://gw.example.com";
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function seedEntry(cloud: string, localUrl?: string): void {
  saveAssistantEntry({
    assistantId: "px",
    name: "Paired",
    runtimeUrl: RUNTIME,
    ...(localUrl ? { localUrl } : {}),
    cloud,
    paired: cloud === "paired",
    species: "vellum",
  });
}

function seedToken(
  accessToken: string,
  refreshToken: string,
  opts?: { due?: boolean },
): void {
  const due = opts?.due ?? true;
  saveGuardianToken("px", {
    guardianPrincipalId: "imported",
    accessToken,
    accessTokenExpiresAt: due ? past() : future(),
    refreshToken,
    refreshTokenExpiresAt: refreshToken ? future() : 0,
    refreshAfter: due ? past() : future(),
    isNew: false,
    deviceId: "dev",
    leasedAt: new Date().toISOString(),
  });
}

function stubRefresh(ok: boolean): {
  hit: () => boolean;
  url: () => string | undefined;
} {
  let calledUrl: string | undefined;
  globalThis.fetch = (async (url: unknown, _init?: RequestInit) => {
    if (String(url).includes("/v1/guardian/refresh")) {
      calledUrl = String(url);
      return new Response(
        ok ? JSON.stringify({ accessToken: "new-acc" }) : "x",
        {
          status: ok ? 200 : 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { hit: () => calledUrl !== undefined, url: () => calledUrl };
}

describe("maybeRefreshAuthHeaders", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tui-midsession-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    // Isolate the lockfile too — saveAssistantEntry writes the prod lockfile
    // (~/.vellum.lock.json) unless VELLUM_LOCKFILE_DIR is set, which would
    // mutate the real user/CI lockfile.
    process.env.VELLUM_LOCKFILE_DIR = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_ENV === undefined) delete process.env.VELLUM_ENVIRONMENT;
    else process.env.VELLUM_ENVIRONMENT = ORIGINAL_ENV;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("refreshes a paired assistant and mutates the auth header in place", async () => {
    seedEntry("paired");
    seedToken("old-acc", "ref");
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(true);
    expect(auth.Authorization).toBe("Bearer new-acc");
    expect(refresh.hit()).toBe(true);
  });

  test("does NOT refresh against an overridden/poisoned baseUrl (no credential leak)", async () => {
    // The CLI lets --url override the runtime URL while still using the stored
    // paired guardian token. A 401 from that attacker origin must NOT cause us
    // to POST the refreshToken + deviceId there.
    seedEntry("paired"); // persisted runtimeUrl = RUNTIME
    seedToken("old-acc", "ref");
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };
    const attacker = "http://attacker.example:7830";

    const ok = await maybeRefreshAuthHeaders(attacker, "px", auth);

    expect(ok).toBe(false);
    expect(auth.Authorization).toBe("Bearer old-acc"); // unchanged
    expect(refresh.hit()).toBe(false); // no refresh POST anywhere
  });

  test("refreshes against the matched persisted URL, keeping the session's interface", async () => {
    // When an entry persists both a loopback localUrl and a different
    // runtimeUrl, a session on the loopback URL must refresh against THAT URL,
    // not the external runtimeUrl (which may be unreachable / public-facing).
    const localUrl = "http://127.0.0.1:7830";
    seedEntry("paired", localUrl); // runtimeUrl = RUNTIME (10.0.0.9), localUrl = loopback
    seedToken("old-acc", "ref");
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(localUrl, "px", auth);

    expect(ok).toBe(true);
    expect(refresh.hit()).toBe(true);
    expect(refresh.url()).toContain("127.0.0.1");
    expect(refresh.url()).not.toContain("10.0.0.9");
  });

  test("does NOT refresh a local assistant (scoped to paired only)", async () => {
    seedEntry("local");
    seedToken("old-acc", "ref"); // even with a refreshable token
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(auth.Authorization).toBe("Bearer old-acc");
    expect(refresh.hit()).toBe(false);
  });

  test("skips platform session auth (no Authorization header)", async () => {
    seedEntry("paired");
    seedToken("old-acc", "ref");
    const refresh = stubRefresh(true);
    const auth = { "X-Session-Token": "sess" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(refresh.hit()).toBe(false);
  });

  test("skips an ephemeral token that does not match the store", async () => {
    seedEntry("paired");
    seedToken("stored-acc", "ref");
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer ephemeral-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(auth.Authorization).toBe("Bearer ephemeral-acc");
    expect(refresh.hit()).toBe(false);
  });

  test("skips an access-only token (no refresh credential)", async () => {
    seedEntry("paired");
    seedToken("old-acc", ""); // no refresh token
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(refresh.hit()).toBe(false);
  });

  test("returns false and leaves auth unchanged when refresh fails", async () => {
    seedEntry("paired");
    seedToken("old-acc", "ref");
    stubRefresh(false); // refresh endpoint returns non-ok
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(auth.Authorization).toBe("Bearer old-acc");
  });

  test("does NOT refresh when the stored token is not due for renewal", async () => {
    // A forged 401 on a still-valid token must not coax out the refresh token.
    seedEntry("paired");
    seedToken("old-acc", "ref", { due: false });
    const refresh = stubRefresh(true);
    const auth = { Authorization: "Bearer old-acc" };

    const ok = await maybeRefreshAuthHeaders(RUNTIME, "px", auth);

    expect(ok).toBe(false);
    expect(auth.Authorization).toBe("Bearer old-acc"); // unchanged
    expect(refresh.hit()).toBe(false); // refresh not attempted
  });
});

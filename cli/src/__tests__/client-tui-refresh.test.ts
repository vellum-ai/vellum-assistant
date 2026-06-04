/**
 * Tests for resolveFreshBearerToken: the `vellum client` TUI proactively
 * refreshes a stale STORED guardian token at startup, while leaving platform
 * session auth, ephemeral --token overrides, and still-fresh tokens untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ENV = process.env.VELLUM_ENVIRONMENT;
const ORIGINAL_FETCH = globalThis.fetch;

import { resolveFreshBearerToken } from "../commands/client.js";
import { saveGuardianToken } from "../lib/guardian-token.js";

const RUNTIME = "http://10.0.0.9:7830";
const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function seed(opts: {
  accessToken: string;
  refreshToken: string;
  refreshAfter: string;
}): void {
  saveGuardianToken("px", {
    guardianPrincipalId: "imported",
    accessToken: opts.accessToken,
    accessTokenExpiresAt: future(),
    refreshToken: opts.refreshToken,
    refreshTokenExpiresAt: future(),
    refreshAfter: opts.refreshAfter,
    isNew: false,
    deviceId: "dev",
    leasedAt: new Date().toISOString(),
  });
}

/** Stub global fetch; returns whether the refresh endpoint was hit. */
function stubRefresh(ok: boolean): { hit: () => boolean } {
  let called = false;
  globalThis.fetch = (async (url: unknown, _init?: RequestInit) => {
    if (String(url).includes("/v1/guardian/refresh")) {
      called = true;
      return new Response(
        ok ? JSON.stringify({ accessToken: "new-acc" }) : "nope",
        {
          status: ok ? 200 : 401,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { hit: () => called };
}

describe("resolveFreshBearerToken", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "client-tui-refresh-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT; // prod config dir
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    if (ORIGINAL_ENV === undefined) delete process.env.VELLUM_ENVIRONMENT;
    else process.env.VELLUM_ENVIRONMENT = ORIGINAL_ENV;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("refreshes a stale stored token and returns the new access token", async () => {
    seed({ accessToken: "old-acc", refreshToken: "ref", refreshAfter: past() });
    const refresh = stubRefresh(true);

    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "old-acc",
      "paired",
    );

    expect(token).toBe("new-acc");
    expect(refresh.hit()).toBe(true);
  });

  test("leaves a still-fresh stored token unchanged (no refresh)", async () => {
    seed({
      accessToken: "old-acc",
      refreshToken: "ref",
      refreshAfter: future(),
    });
    const refresh = stubRefresh(true);

    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "old-acc",
      "paired",
    );

    expect(token).toBe("old-acc");
    expect(refresh.hit()).toBe(false);
  });

  test("does not refresh an ephemeral --token (mismatches the store)", async () => {
    seed({ accessToken: "old-acc", refreshToken: "ref", refreshAfter: past() });
    const refresh = stubRefresh(true);

    // bearerToken differs from the stored accessToken => ephemeral override.
    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "ephemeral-tok",
      "paired",
    );

    expect(token).toBe("ephemeral-tok");
    expect(refresh.hit()).toBe(false);
  });

  test("never refreshes on the platform session-auth path", async () => {
    seed({ accessToken: "old-acc", refreshToken: "ref", refreshAfter: past() });
    const refresh = stubRefresh(true);

    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "old-acc",
      "vellum",
    );

    expect(token).toBe("old-acc");
    expect(refresh.hit()).toBe(false);
  });

  test("falls back to the existing token when refresh fails", async () => {
    seed({ accessToken: "old-acc", refreshToken: "ref", refreshAfter: past() });
    stubRefresh(false); // refresh endpoint returns non-ok

    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "old-acc",
      "paired",
    );

    expect(token).toBe("old-acc");
  });

  test("does not refresh an access-only stored token (no refresh credential)", async () => {
    seed({ accessToken: "old-acc", refreshToken: "", refreshAfter: past() });
    const refresh = stubRefresh(true);

    const token = await resolveFreshBearerToken(
      RUNTIME,
      "px",
      "old-acc",
      "paired",
    );

    expect(token).toBe("old-acc");
    expect(refresh.hit()).toBe(false);
  });
});

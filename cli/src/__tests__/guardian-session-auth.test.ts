import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveAssistantEntry } from "../lib/assistant-config.js";
import {
  resolveGuardianSessionAuth,
  type GuardianSessionAuthResult,
} from "../lib/guardian-session-auth.js";
import { saveGuardianToken } from "../lib/guardian-token.js";

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ENV = process.env.VELLUM_ENVIRONMENT;
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_FETCH = globalThis.fetch;

const ASSISTANT_ID = "assistant-123";
const RUNTIME_URL = "https://gateway.example.com";
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function seedEntry(runtimeUrl = RUNTIME_URL, localUrl?: string): void {
  saveAssistantEntry({
    assistantId: ASSISTANT_ID,
    name: "Example Assistant",
    runtimeUrl,
    localUrl,
    cloud: "paired",
    paired: true,
    species: "vellum",
  });
}

function seedToken(options?: {
  refreshAfter?: string;
  refreshTokenExpiresAt?: string;
}): void {
  saveGuardianToken(ASSISTANT_ID, {
    guardianPrincipalId: "guardian-123",
    accessToken: "access-old",
    accessTokenExpiresAt: future(),
    refreshToken: "refresh-old",
    refreshTokenExpiresAt: options?.refreshTokenExpiresAt ?? future(),
    refreshAfter: options?.refreshAfter ?? future(),
    isNew: false,
    deviceId: "device-123",
    leasedAt: new Date().toISOString(),
  });
}

function resolve(runtimeUrl = RUNTIME_URL): Promise<GuardianSessionAuthResult> {
  return resolveGuardianSessionAuth({
    runtimeUrl,
    assistantId: ASSISTANT_ID,
    accessToken: "access-old",
    cloud: "paired",
  });
}

describe("guardian session authentication", () => {
  let tempHome: string;
  let refreshUrl: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "guardian-session-auth-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    process.env.VELLUM_LOCKFILE_DIR = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
    refreshUrl = undefined;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      refreshUrl = String(url);
      return Response.json({
        accessToken: "access-new",
        accessTokenExpiresAt: future(),
        refreshToken: "refresh-new",
        refreshTokenExpiresAt: future(),
        refreshAfter: future(),
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    if (ORIGINAL_LOCKFILE_DIR === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    }
    if (ORIGINAL_ENV === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = ORIGINAL_ENV;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("reuses a current stored guardian access token", async () => {
    seedEntry();
    seedToken();

    expect(await resolve()).toEqual({
      ok: true,
      accessToken: "access-old",
      refreshed: false,
    });
    expect(refreshUrl).toBeUndefined();
  });

  test("refreshes a stored guardian token that is due", async () => {
    seedEntry();
    seedToken({ refreshAfter: past() });

    expect(await resolve()).toEqual({
      ok: true,
      accessToken: "access-new",
      refreshed: true,
    });
    expect(refreshUrl).toBe(`${RUNTIME_URL}/v1/guardian/refresh`);
  });

  test("returns a typed failure when the refresh credential is expired", async () => {
    seedEntry();
    seedToken({
      refreshAfter: past(),
      refreshTokenExpiresAt: past(),
    });

    const result = await resolve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.accessToken).toBe("access-old");
      expect(result.error.code).toBe("refresh_failed");
    }
    expect(refreshUrl).toBeUndefined();
  });

  test("refreshes through the matching persisted local URL", async () => {
    const localUrl = "http://127.0.0.1:7830";
    seedEntry("https://gateway.example.com", localUrl);
    seedToken({ refreshAfter: past() });

    const result = await resolve(localUrl);

    expect(result.ok).toBe(true);
    expect(refreshUrl).toBe(`${localUrl}/v1/guardian/refresh`);
  });

  test("rejects refresh through an explicit URL that is not persisted", async () => {
    seedEntry();
    seedToken({ refreshAfter: past() });

    const result = await resolve("https://other-gateway.example.com");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.accessToken).toBe("access-old");
      expect(result.error.code).toBe("untrusted_refresh_destination");
    }
    expect(refreshUrl).toBeUndefined();
  });
});

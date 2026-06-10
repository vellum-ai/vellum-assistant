import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  broadcastUpgradeEvent,
  commitWorkspaceViaGateway,
  resolveLifecycleGuardianAccessToken,
} from "../lib/upgrade-lifecycle.js";
import {
  saveGuardianToken,
  type GuardianTokenData,
} from "../lib/guardian-token.js";

const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_VELLUM_ENVIRONMENT = process.env.VELLUM_ENVIRONMENT;
const ORIGINAL_FETCH = globalThis.fetch;

const GATEWAY_URL = "http://127.0.0.1:7830";
const ASSISTANT_ID = "asst-auth";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

interface Call {
  url: string;
  init?: RequestInit;
}

function tokenData(
  overrides: Partial<GuardianTokenData> = {},
): GuardianTokenData {
  return {
    guardianPrincipalId: "principal-auth",
    accessToken: "access-old",
    accessTokenExpiresAt: FUTURE,
    refreshToken: "refresh-old",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: FUTURE,
    isNew: false,
    deviceId: "device-auth",
    leasedAt: new Date().toISOString(),
    ...overrides,
  };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function stubFetch(handler?: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return handler?.(url) ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}

describe("upgrade lifecycle gateway auth", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "upgrade-lifecycle-auth-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
    }
    if (ORIGINAL_VELLUM_ENVIRONMENT === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = ORIGINAL_VELLUM_ENVIRONMENT;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("skips best-effort admin requests when no guardian token can be resolved", async () => {
    const calls = stubFetch();

    await broadcastUpgradeEvent(GATEWAY_URL, ASSISTANT_ID, {
      type: "starting",
    });

    expect(calls).toHaveLength(0);
  });

  test("sends workspace commits with Authorization when a guardian token exists", async () => {
    saveGuardianToken(ASSISTANT_ID, tokenData({ accessToken: "access-ready" }));
    const calls = stubFetch();

    await commitWorkspaceViaGateway(GATEWAY_URL, ASSISTANT_ID, "test commit");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${GATEWAY_URL}/v1/admin/workspace-commit`);
    expect(header(calls[0]?.init, "Authorization")).toBe("Bearer access-ready");
  });

  test("refreshes stale guardian tokens before lifecycle calls", async () => {
    saveGuardianToken(
      ASSISTANT_ID,
      tokenData({
        accessToken: "access-expired",
        accessTokenExpiresAt: PAST,
        refreshAfter: PAST,
      }),
    );
    const calls = stubFetch((url) => {
      if (url.endsWith("/v1/guardian/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: "access-refreshed",
            refreshToken: "refresh-new",
            accessTokenExpiresAt: FUTURE,
            refreshTokenExpiresAt: FUTURE,
            refreshAfter: FUTURE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const token = await resolveLifecycleGuardianAccessToken(
      GATEWAY_URL,
      ASSISTANT_ID,
    );
    await broadcastUpgradeEvent(GATEWAY_URL, ASSISTANT_ID, {
      type: "progress",
    });

    expect(token).toBe("access-refreshed");
    expect(calls.map((call) => call.url)).toEqual([
      `${GATEWAY_URL}/v1/guardian/refresh`,
      `${GATEWAY_URL}/v1/admin/upgrade-broadcast`,
    ]);
    expect(header(calls[1]?.init, "Authorization")).toBe(
      "Bearer access-refreshed",
    );
  });

  test("skips lifecycle requests when an expired token cannot be refreshed", async () => {
    saveGuardianToken(
      ASSISTANT_ID,
      tokenData({
        accessToken: "access-expired",
        accessTokenExpiresAt: PAST,
        refreshAfter: PAST,
      }),
    );
    const calls = stubFetch(() => new Response("nope", { status: 401 }));

    const token = await resolveLifecycleGuardianAccessToken(
      GATEWAY_URL,
      ASSISTANT_ID,
    );
    await broadcastUpgradeEvent(GATEWAY_URL, ASSISTANT_ID, {
      type: "progress",
    });

    expect(token).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${GATEWAY_URL}/v1/guardian/refresh`,
      `${GATEWAY_URL}/v1/guardian/refresh`,
    ]);
  });
});

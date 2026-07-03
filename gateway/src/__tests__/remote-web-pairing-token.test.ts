import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const mockQuery = mock();
const mockRun = mock();
const mockExec = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mockRun,
  assistantDbExec: mockExec,
}));

const { hashToken, mintAndRecordDeviceBoundTokenPair } =
  await import("../auth/guardian-bootstrap.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const {
  actorRefreshTokenRecords,
  actorTokenRecords,
  contacts,
  contactChannels,
} = await import("../db/schema.js");
const { handleGuardianRefresh } =
  await import("../http/routes/guardian-refresh.js");
const { handleRemoteWebPairingToken } =
  await import("../http/routes/remote-web-pairing-token.js");
const {
  approveRemoteWebPairingChallenge,
  createRemoteWebPairingChallenge,
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");

const GUARDIAN_ID = "guardian-001";
const PUBLIC_BASE_URL = "https://paired.example.com";

let testRoot: string;

function makeTokenRequest(body: unknown): Request {
  return new Request("https://paired.example.com/v1/remote-web/pairing-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeRefreshRequest(
  refreshToken: string,
  opts: {
    origin?: string | null;
    referer?: string | null;
    secFetchSite?: string | null;
    url?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    cookie: `vellum_web_refresh=${encodeURIComponent(refreshToken)}`,
  };
  const secFetchSite = Object.prototype.hasOwnProperty.call(
    opts,
    "secFetchSite",
  )
    ? opts.secFetchSite
    : "same-origin";
  if (typeof secFetchSite === "string") {
    headers["sec-fetch-site"] = secFetchSite;
  }
  if (typeof opts.origin === "string") {
    headers.origin = opts.origin;
  }
  if (typeof opts.referer === "string") {
    headers.referer = opts.referer;
  }

  return new Request(
    opts.url ?? "https://paired.example.com/v1/guardian/refresh",
    {
      method: "POST",
      headers,
    },
  );
}

function makeDeviceRefreshRequest(params: {
  refreshToken: string;
  deviceId: string;
}): Request {
  return new Request("https://paired.example.com/v1/guardian/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
}

function setCookies(res: Response): string[] {
  const headers = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = headers.getSetCookie?.();
  if (cookies) return cookies;
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  expect(cookie).toBeTruthy();
  return decodeURIComponent(cookie!.split(";")[0].slice(name.length + 1));
}

// findVellumGuardian() now reads the gateway DB, so seed the guardian there.
function seedGatewayGuardian() {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "contact-guardian",
      displayName: "guardian",
      role: "guardian",
      principalId: GUARDIAN_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: "channel-guardian",
      contactId: "contact-guardian",
      type: "vellum",
      address: GUARDIAN_ID,
      isPrimary: true,
      status: "active",
      policy: "allow",
      verifiedAt: now,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function clearGatewayGuardian() {
  getGatewayDb().delete(contactChannels).run();
  getGatewayDb().delete(contacts).run();
}

function activeTokens() {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.status, "active"))
    .all();
}

function activeRefreshTokens() {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.status, "active"))
    .all();
}

beforeEach(async () => {
  resetRemoteWebPairingChallengesForTests();
  mockQuery.mockResolvedValue([{ principal_id: GUARDIAN_ID }]);
  mockRun.mockReset();
  mockExec.mockReset();
  testRoot = mkdtempSync(join(tmpdir(), "remote-web-pairing-token-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
  seedGatewayGuardian();
});

afterEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("remote web pairing token exchange", () => {
  test("returns pending before the user approves the code", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);

    const res = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "pending",
      expiresAt: challenge.expiresAt,
      intervalSeconds: challenge.intervalSeconds,
    });
    expect(activeTokens()).toHaveLength(0);
  });

  test("approved device code mints access token and HttpOnly refresh cookies once", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const res = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("approved");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.accessTokenExpiresAt).toBe("string");
    expect(typeof body.refreshAfter).toBe("string");
    expect(body.guardianId).toBe(GUARDIAN_ID);
    expect(body.refreshToken).toBeUndefined();
    expect(body.deviceId).toBeUndefined();

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/v1/guardian/refresh");
    }

    const refreshToken = cookieValue(cookies, "vellum_web_refresh");
    const tokens = activeTokens();
    const refreshTokens = activeRefreshTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(tokens[0].platform).toBe("web");
    expect(refreshTokens).toHaveLength(1);
    expect(refreshTokens[0].tokenHash).toBe(hashToken(refreshToken));
    expect(refreshTokens[0].hashedDeviceId).toBe(tokens[0].hashedDeviceId);

    const replay = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );
    expect(replay.status).toBe(401);
    expect(setCookies(replay)).toHaveLength(0);
    expect(activeTokens()).toHaveLength(1);
  });

  test("browser refresh rotates using only the HttpOnly refresh cookie", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const exchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );
    const originalRefreshToken = cookieValue(
      setCookies(exchange),
      "vellum_web_refresh",
    );
    const originalRefreshRecord = activeRefreshTokens()[0];

    const refresh = await handleGuardianRefresh(
      makeRefreshRequest(originalRefreshToken),
    );

    expect(refresh.status).toBe(200);
    expect(refresh.headers.get("Cache-Control")).toBe("no-store");
    const body = (await refresh.json()) as Record<string, unknown>;
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.accessTokenExpiresAt).toBe("number");
    expect(typeof body.refreshAfter).toBe("number");
    expect(body.refreshToken).toBeUndefined();
    expect(body.deviceId).toBeUndefined();

    const rotatedRefreshToken = cookieValue(
      setCookies(refresh),
      "vellum_web_refresh",
    );
    expect(rotatedRefreshToken).not.toBe(originalRefreshToken);

    const refreshTokens = getGatewayDb()
      .select()
      .from(actorRefreshTokenRecords)
      .all();
    expect(
      refreshTokens.find((token) => token.id === originalRefreshRecord.id)
        ?.status,
    ).toBe("rotated");
    expect(activeRefreshTokens()).toHaveLength(1);
    expect(activeRefreshTokens()[0].tokenHash).toBe(
      hashToken(rotatedRefreshToken),
    );
    expect(activeTokens()).toHaveLength(1);
  });

  test("browser refresh rejects non-same-origin fetch metadata", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const exchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );
    const originalRefreshToken = cookieValue(
      setCookies(exchange),
      "vellum_web_refresh",
    );

    for (const secFetchSite of ["cross-site", "same-site", "none"]) {
      const refresh = await handleGuardianRefresh(
        makeRefreshRequest(originalRefreshToken, {
          origin: PUBLIC_BASE_URL,
          secFetchSite,
        }),
      );

      expect(refresh.status).toBe(403);
      expect(await refresh.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "Browser refresh requires a same-origin request",
        },
      });
      expect(setCookies(refresh)).toHaveLength(0);
    }

    expect(activeRefreshTokens()).toHaveLength(1);
    expect(activeRefreshTokens()[0].tokenHash).toBe(
      hashToken(originalRefreshToken),
    );
  });

  test("browser refresh falls back to same-origin request headers when fetch metadata is missing", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const originExchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );
    const originRefreshToken = cookieValue(
      setCookies(originExchange),
      "vellum_web_refresh",
    );

    const originRefresh = await handleGuardianRefresh(
      makeRefreshRequest(originRefreshToken, {
        origin: PUBLIC_BASE_URL,
        secFetchSite: null,
        url: "http://paired.example.com/v1/guardian/refresh",
      }),
    );

    expect(originRefresh.status).toBe(200);
    expect(
      cookieValue(setCookies(originRefresh), "vellum_web_refresh"),
    ).not.toBe(originRefreshToken);

    const refererChallenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(
      approveRemoteWebPairingChallenge(refererChallenge.userCode).status,
    ).toBe("approved");
    const refererExchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: refererChallenge.deviceCode }),
    );
    const refererRefreshToken = cookieValue(
      setCookies(refererExchange),
      "vellum_web_refresh",
    );

    const refererRefresh = await handleGuardianRefresh(
      makeRefreshRequest(refererRefreshToken, {
        referer: `${PUBLIC_BASE_URL}/assistant/`,
        secFetchSite: null,
      }),
    );

    expect(refererRefresh.status).toBe(200);
    expect(
      cookieValue(setCookies(refererRefresh), "vellum_web_refresh"),
    ).not.toBe(refererRefreshToken);
  });

  test("browser refresh rejects missing fetch metadata without a same-origin fallback", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const exchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );
    const originalRefreshToken = cookieValue(
      setCookies(exchange),
      "vellum_web_refresh",
    );

    for (const opts of [
      { secFetchSite: null },
      {
        origin: "https://attacker.example.com",
        secFetchSite: null,
      },
      {
        referer: "https://attacker.example.com/assistant/",
        secFetchSite: null,
      },
    ]) {
      const refresh = await handleGuardianRefresh(
        makeRefreshRequest(originalRefreshToken, opts),
      );

      expect(refresh.status).toBe(403);
      expect(await refresh.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "Browser refresh requires a same-origin request",
        },
      });
      expect(setCookies(refresh)).toHaveLength(0);
    }

    expect(activeRefreshTokens()).toHaveLength(1);
    expect(activeRefreshTokens()[0].tokenHash).toBe(
      hashToken(originalRefreshToken),
    );
  });

  test("device-bound refresh path does not require fetch metadata", async () => {
    const pair = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "legacy-device",
      platform: "cli",
    });

    const refresh = await handleGuardianRefresh(
      makeDeviceRefreshRequest({
        refreshToken: pair.refreshToken,
        deviceId: "legacy-device",
      }),
    );

    expect(refresh.status).toBe(200);
    const body = (await refresh.json()) as Record<string, unknown>;
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(typeof body.refreshAfter).toBe("number");
    expect(setCookies(refresh)).toHaveLength(0);
  });

  test("path-prefixed public base URLs keep refresh cookies on the public refresh path", async () => {
    const publicBaseUrl = `${PUBLIC_BASE_URL}/assistant-123`;
    const expectedCookiePath = "/assistant-123/v1/guardian/refresh";
    const challenge = createRemoteWebPairingChallenge(publicBaseUrl);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    const exchange = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    const exchangeCookies = setCookies(exchange);
    expect(exchangeCookies).toHaveLength(1);
    expect(exchangeCookies[0]).toContain(`Path=${expectedCookiePath}`);
    const originalRefreshToken = cookieValue(
      exchangeCookies,
      "vellum_web_refresh",
    );
    expect(activeRefreshTokens()[0].browserRefreshCookiePath).toBe(
      expectedCookiePath,
    );

    const refresh = await handleGuardianRefresh(
      makeRefreshRequest(originalRefreshToken),
    );

    expect(refresh.status).toBe(200);
    const refreshCookies = setCookies(refresh);
    expect(refreshCookies).toHaveLength(1);
    expect(refreshCookies[0]).toContain(`Path=${expectedCookiePath}`);
    expect(activeRefreshTokens()[0].browserRefreshCookiePath).toBe(
      expectedCookiePath,
    );
  });

  test("cookie refresh rejects legacy device-bound refresh tokens", async () => {
    const legacyPair = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "legacy-device",
      platform: "cli",
    });

    const refresh = await handleGuardianRefresh(
      makeRefreshRequest(legacyPair.refreshToken),
    );

    expect(refresh.status).toBe(401);
    expect(await refresh.json()).toEqual({ error: "refresh_invalid" });
    const refreshTokens = activeRefreshTokens();
    expect(refreshTokens).toHaveLength(1);
    expect(refreshTokens[0].tokenHash).toBe(hashToken(legacyPair.refreshToken));
    expect(refreshTokens[0].browserRefreshCookiePath).toBeNull();
  });

  test("assistant mirror failure does not fail the gateway-committed binding", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    // No gateway guardian: resolveOrCreateVellumGuardian mints fresh via
    // createGuardianBinding, which writes the authoritative gateway binding
    // first, then mirrors identity to the assistant DB. The mirror write fails
    // this once; the gateway binding is now authoritative so the mint succeeds.
    clearGatewayGuardian();
    mockRun.mockRejectedValueOnce(new Error("temporary guardian mirror write"));
    const res = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    expect(res.status).toBe(200);
    expect(setCookies(res)).toHaveLength(1);
    expect(activeTokens()).toHaveLength(1);
    expect(activeRefreshTokens()).toHaveLength(1);

    // Gateway carries the authoritative guardian binding despite the mirror
    // failure.
    const gwGuardian = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.role, "guardian"))
      .all();
    expect(gwGuardian).toHaveLength(1);
    expect(gwGuardian[0].principalId).toMatch(/^vellum-principal-/);
  });

  test("gateway binding write failure fails the mint and leaves the code retryable", async () => {
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );

    // No gateway guardian: createGuardianBinding must write the authoritative
    // gateway binding. Force that write to throw and confirm it propagates so
    // nothing is consumed.
    clearGatewayGuardian();
    const gwDb = getGatewayDb();
    const realTransaction = gwDb.transaction.bind(gwDb);
    let failedOnce = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gwDb as any).transaction = (...args: unknown[]) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("gateway binding write failed");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realTransaction as any)(...args);
    };

    try {
      await expect(
        handleRemoteWebPairingToken(
          makeTokenRequest({ deviceCode: challenge.deviceCode }),
        ),
      ).rejects.toThrow("gateway binding write failed");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gwDb as any).transaction = realTransaction;
    }

    expect(
      getRemoteWebPairingChallengeForTests(challenge.userCode)?.status,
    ).toBe("approved");
    expect(activeTokens()).toHaveLength(0);
    expect(activeRefreshTokens()).toHaveLength(0);

    seedGatewayGuardian();
    const retry = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    expect(retry.status).toBe(200);
    expect(setCookies(retry)).toHaveLength(1);
    expect(activeTokens()).toHaveLength(1);
    expect(activeRefreshTokens()).toHaveLength(1);
  });

  test("expired device code does not mint credentials", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(PUBLIC_BASE_URL);
    expect(approveRemoteWebPairingChallenge(challenge.userCode).status).toBe(
      "approved",
    );
    setRemoteWebPairingChallengeNowForTests(() => 601_000);

    const res = await handleRemoteWebPairingToken(
      makeTokenRequest({ deviceCode: challenge.deviceCode }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_OR_EXPIRED_DEVICE_CODE",
        message: "invalid or expired pairing device code",
      },
    });
    expect(activeTokens()).toHaveLength(0);
    expect(activeRefreshTokens()).toHaveLength(0);
  });
});

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { testSecurityDir } from "./test-preload.js";
import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const featureFlagStorePath = join(testSecurityDir, "feature-flags.json");
const defaultsPath = join(testSecurityDir, "feature-flag-registry.json");

const GUARDIAN_ID = "guardian-001";

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "web-remote-ingress",
      scope: "assistant",
      key: "web-remote-ingress",
      label: "Web Remote Ingress",
      description: "Enable browser remote ingress.",
      defaultEnabled: false,
    },
  ],
};

const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache } = await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache } =
  await import("../feature-flag-remote-store.js");
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorRefreshTokenRecords, actorTokenRecords } =
  await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { webBootstrapRoutes } = await import("../ipc/web-bootstrap-handlers.js");

const mintWebCredentialsRoute = webBootstrapRoutes[0];

async function callMintWebCredentials(params: Record<string, unknown>) {
  return (await mintWebCredentialsRoute.handler(params)) as Record<
    string,
    unknown
  >;
}

async function getRouteError(params: Record<string, unknown>): Promise<string> {
  try {
    await mintWebCredentialsRoute.handler(params);
  } catch (err) {
    return String(err);
  }
  throw new Error("Expected route handler to throw");
}

function activeActorTokens() {
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

function enableWebRemoteIngress(): void {
  writeFileSync(
    featureFlagStorePath,
    JSON.stringify({
      version: 1,
      values: { "web-remote-ingress": true },
    }),
  );
  clearFeatureFlagStoreCache();
}

describe("IPC web bootstrap routes", () => {
  beforeEach(async () => {
    mkdirSync(testSecurityDir, { recursive: true });
    writeFileSync(defaultsPath, JSON.stringify(TEST_REGISTRY, null, 2));
    _setRegistryCandidateOverrides([defaultsPath]);
    resetFeatureFlagDefaultsCache();
    clearFeatureFlagStoreCache();
    clearRemoteFeatureFlagStoreCache();
    resetEnvOverridesCache();
    mockQuery.mockResolvedValue([
      { contact_id: "contact-001", principal_id: GUARDIAN_ID },
    ]);
    await initGatewayDb();
  });

  afterEach(() => {
    resetGatewayDb();
    _setRegistryCandidateOverrides(null);
    resetFeatureFlagDefaultsCache();
    clearFeatureFlagStoreCache();
    clearRemoteFeatureFlagStoreCache();
    resetEnvOverridesCache();
    try {
      rmSync(testSecurityDir, { recursive: true, force: true });
      mkdirSync(testSecurityDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  test("rejects minting while web remote ingress is disabled", async () => {
    const error = await getRouteError({
      deviceId: "browser-device",
    });

    expect(error).toContain("web-remote-ingress feature flag is disabled");
    expect(activeActorTokens()).toHaveLength(0);
    expect(activeRefreshTokens()).toHaveLength(0);
  });

  test("mints recorded web credentials when the feature flag is enabled", async () => {
    enableWebRemoteIngress();

    const body = await callMintWebCredentials({
      deviceId: "browser-device",
      clientId: "browser-client",
    });

    expect(body.assistantId).toBe("self");
    expect(body.guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.accessTokenExpiresAt).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(typeof body.refreshTokenExpiresAt).toBe("string");
    expect(typeof body.refreshAfter).toBe("string");

    const tokens = activeActorTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(tokens[0].hashedDeviceId).toBe(hashToken("browser-device"));
    expect(tokens[0].platform).toBe("web");

    const refreshTokens = activeRefreshTokens();
    expect(refreshTokens).toHaveLength(1);
    expect(refreshTokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(refreshTokens[0].hashedDeviceId).toBe(hashToken("browser-device"));
    expect(refreshTokens[0].tokenHash).toBe(
      hashToken(body.refreshToken as string),
    );
  });

  test("validates that a device id is present", async () => {
    enableWebRemoteIngress();

    const schemaResult = mintWebCredentialsRoute.schema!.safeParse({
      deviceId: "  ",
    });
    expect(schemaResult.success).toBe(false);

    const error = await getRouteError({ deviceId: "  " });
    expect(error).toContain("Too small");
    expect(activeActorTokens()).toHaveLength(0);
  });
});

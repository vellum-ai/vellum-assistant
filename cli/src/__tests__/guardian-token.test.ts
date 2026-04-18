import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOrCreatePersistedDeviceId,
  loadGuardianToken,
  saveGuardianToken,
  seedGuardianTokenFromSiblingEnv,
  type GuardianTokenData,
} from "../lib/guardian-token.js";

function makeTokenData(suffix: string): GuardianTokenData {
  const now = new Date().toISOString();
  return {
    guardianPrincipalId: `principal-${suffix}`,
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: now,
    refreshToken: `refresh-${suffix}`,
    refreshTokenExpiresAt: now,
    refreshAfter: now,
    isNew: true,
    deviceId: `device-${suffix}`,
    leasedAt: now,
  };
}

describe("guardian-token paths are env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-token-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod: guardian token lands at $XDG_CONFIG_HOME/vellum/assistants/<id>/guardian-token.json", () => {
    const data = makeTokenData("prod");
    saveGuardianToken("alpha", data);

    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(prodPath, "utf-8"));
    expect(parsed.guardianPrincipalId).toBe("principal-prod");

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-prod");
  });

  test("dev: guardian token lands at $XDG_CONFIG_HOME/vellum-dev/assistants/<id>/guardian-token.json", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const data = makeTokenData("dev");
    saveGuardianToken("alpha", data);

    const devPath = join(
      tempHome,
      "vellum-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(devPath)).toBe(true);

    // Prod directory must NOT have this token
    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(false);

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");
  });

  test("same assistant id in prod and dev is isolated on disk", () => {
    // Write prod token for assistant 'alpha'
    delete process.env.VELLUM_ENVIRONMENT;
    saveGuardianToken("alpha", makeTokenData("prod"));

    // Write dev token for assistant 'alpha'
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Dev load returns dev
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-dev",
    );

    // Back to prod — prod token is unchanged
    delete process.env.VELLUM_ENVIRONMENT;
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-prod",
    );

    // Both files exist at distinct paths
    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    const devPath = join(
      tempHome,
      "vellum-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    expect(existsSync(devPath)).toBe(true);
    expect(prodPath).not.toBe(devPath);
  });

  test("prod: persisted device id lands at $XDG_CONFIG_HOME/vellum/device-id", () => {
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const prodPath = join(tempHome, "vellum", "device-id");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(id);
  });

  test("dev: persisted device id lands at $XDG_CONFIG_HOME/vellum-dev/device-id", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const devPath = join(tempHome, "vellum-dev", "device-id");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(id);

    const prodPath = join(tempHome, "vellum", "device-id");
    expect(existsSync(prodPath)).toBe(false);
  });

  test("device id is stable across repeated calls in the same env", () => {
    delete process.env.VELLUM_ENVIRONMENT;
    const first = getOrCreatePersistedDeviceId();
    const second = getOrCreatePersistedDeviceId();
    expect(first).toBe(second);
  });

  test("seedGuardianTokenFromSiblingEnv copies a dev token into the current local env", () => {
    // Write a token under the dev env.
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Switch to local env — no token present yet.
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(loadGuardianToken("alpha")).toBeNull();

    const seeded = seedGuardianTokenFromSiblingEnv("alpha");
    expect(seeded).toBe(true);

    const localPath = join(
      tempHome,
      "vellum-local",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(localPath)).toBe(true);
    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");

    // Idempotent — second call is a no-op.
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
  });

  test("seedGuardianTokenFromSiblingEnv returns false when no sibling token exists", () => {
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("nonexistent")).toBe(false);
    expect(loadGuardianToken("nonexistent")).toBeNull();
  });

  test("seedGuardianTokenFromSiblingEnv does not overwrite an existing token", () => {
    // Token already present in the current env.
    process.env.VELLUM_ENVIRONMENT = "local";
    saveGuardianToken("alpha", makeTokenData("local"));

    // And a different sibling token in dev.
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Back to local — seed should no-op because a token is already present.
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-local",
    );
  });
});

/**
 * Tests for the capability-token secret lifecycle and mint/verify
 * helpers. These paths are covered transitively by
 * `browser-extension-pair-routes.test.ts` for the happy-path mint flow,
 * but the on-disk secret lifecycle (first-call creation with mode 0600,
 * legacy workspace → protected migration, corrupt-secret regeneration)
 * has no direct coverage elsewhere.
 *
 * All tests use temp directories and inject paths via the
 * `CapabilityTokenSecretPaths` parameter so none of them touch the real
 * `~/.vellum/` tree. Mint/verify tests inject a deterministic secret
 * via `setCapabilityTokenSecretForTests` + `resetCapabilityTokenSecretForTests`.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type CapabilityTokenSecretPaths,
  loadOrCreateCapabilityTokenSecret,
  mintHostBrowserCapability,
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
  verifyHostBrowserCapability,
} from "../capability-tokens.js";

// ---------------------------------------------------------------------------
// Temp-directory helpers
// ---------------------------------------------------------------------------

interface TempPaths extends CapabilityTokenSecretPaths {
  root: string;
  protectedDir: string;
  legacyDir: string;
}

function makeTempPaths(): TempPaths {
  const root = mkdtempSync(join(tmpdir(), "vellum-cap-tok-"));
  const protectedDir = join(root, "protected");
  const legacyDir = join(root, "workspace", "data");
  return {
    root,
    protectedDir,
    legacyDir,
    secretPath: join(protectedDir, "capability-token-secret"),
    legacySecretPath: join(legacyDir, "capability-token-secret"),
  };
}

function cleanupTempPaths(paths: TempPaths): void {
  try {
    rmSync(paths.root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Secret lifecycle
// ---------------------------------------------------------------------------

describe("loadOrCreateCapabilityTokenSecret", () => {
  let paths: TempPaths;

  beforeEach(() => {
    paths = makeTempPaths();
  });

  afterEach(() => {
    cleanupTempPaths(paths);
  });

  test("first call generates a fresh 32-byte secret and persists it with mode 0600", () => {
    const secret = loadOrCreateCapabilityTokenSecret(paths);
    expect(secret.length).toBe(32);
    expect(existsSync(paths.secretPath)).toBe(true);

    const mode = statSync(paths.secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("second call returns the same bytes persisted on the first call", () => {
    const first = loadOrCreateCapabilityTokenSecret(paths);
    const second = loadOrCreateCapabilityTokenSecret(paths);
    expect(Buffer.compare(first, second)).toBe(0);
  });

  test("legacy workspace secret is migrated into the protected directory and removed from workspace", () => {
    mkdirSync(paths.legacyDir, { recursive: true });
    const legacySecret = randomBytes(32);
    writeFileSync(paths.legacySecretPath, legacySecret, { mode: 0o600 });
    expect(existsSync(paths.legacySecretPath)).toBe(true);
    expect(existsSync(paths.secretPath)).toBe(false);

    const loaded = loadOrCreateCapabilityTokenSecret(paths);

    expect(Buffer.compare(loaded, legacySecret)).toBe(0);
    // After migration, legacy copy is gone and the protected copy is
    // the authoritative location.
    expect(existsSync(paths.legacySecretPath)).toBe(false);
    expect(existsSync(paths.secretPath)).toBe(true);
    const persisted = readFileSync(paths.secretPath);
    expect(Buffer.compare(persisted, legacySecret)).toBe(0);

    // Migrated file should inherit 0o600 too.
    const mode = statSync(paths.secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a corrupt / truncated secret file is regenerated instead of throwing", () => {
    mkdirSync(paths.protectedDir, { recursive: true });
    writeFileSync(paths.secretPath, Buffer.from([0x00, 0x01, 0x02]), {
      mode: 0o600,
    });
    expect(statSync(paths.secretPath).size).toBe(3);

    const loaded = loadOrCreateCapabilityTokenSecret(paths);

    expect(loaded.length).toBe(32);
    const persisted = readFileSync(paths.secretPath);
    expect(persisted.length).toBe(32);
    expect(Buffer.compare(loaded, persisted)).toBe(0);
  });

  test("a legacy secret with unexpected length is ignored and a fresh secret is generated", () => {
    mkdirSync(paths.legacyDir, { recursive: true });
    writeFileSync(paths.legacySecretPath, Buffer.from([0xaa, 0xbb]), {
      mode: 0o600,
    });

    const loaded = loadOrCreateCapabilityTokenSecret(paths);

    expect(loaded.length).toBe(32);
    // Short legacy file is left alone (it doesn't look like a valid
    // legacy secret) and a fresh secret is written to the protected path.
    expect(existsSync(paths.secretPath)).toBe(true);
    const persisted = readFileSync(paths.secretPath);
    expect(Buffer.compare(persisted, loaded)).toBe(0);
  });

  test("an unreadable (permission-denied) secret file is regenerated", () => {
    mkdirSync(paths.protectedDir, { recursive: true });
    writeFileSync(paths.secretPath, randomBytes(32), { mode: 0o600 });
    // Strip read permissions so readFileSync throws. Skip the test if
    // we're running as root (where chmod can't lock us out).
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    chmodSync(paths.secretPath, 0o000);

    const loaded = loadOrCreateCapabilityTokenSecret(paths);
    expect(loaded.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Mint / verify
// ---------------------------------------------------------------------------

describe("mint / verify round trip", () => {
  beforeEach(() => {
    // Inject a deterministic secret so mint/verify don't depend on the
    // on-disk secret file at all.
    setCapabilityTokenSecretForTests(randomBytes(32));
  });

  afterEach(() => {
    resetCapabilityTokenSecretForTests();
  });

  test("a freshly minted token verifies and decodes to the same guardian id", () => {
    const { token, expiresAt } = mintHostBrowserCapability("guardian-abc");
    expect(typeof token).toBe("string");
    expect(expiresAt).toBeGreaterThan(Date.now());

    const claims = verifyHostBrowserCapability(token);
    expect(claims).not.toBeNull();
    expect(claims?.guardianId).toBe("guardian-abc");
    expect(claims?.capability).toBe("host_browser_command");
    expect(claims?.expiresAt).toBe(expiresAt);
  });

  test("a tampered payload fails verification", () => {
    const { token } = mintHostBrowserCapability("guardian-abc");
    // Flip the last character of the payload half to invalidate the
    // HMAC signature (payload is `<b64>.<b64>`; we mutate before the dot).
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const lastChar = payload[payload.length - 1]!;
    const replacement = lastChar === "A" ? "B" : "A";
    const mutatedPayload = payload.slice(0, -1) + replacement;
    const mutated = `${mutatedPayload}.${sig}`;

    const claims = verifyHostBrowserCapability(mutated);
    expect(claims).toBeNull();
  });

  test("a tampered signature fails verification", () => {
    const { token } = mintHostBrowserCapability("guardian-abc");
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const lastChar = sig[sig.length - 1]!;
    const replacement = lastChar === "A" ? "B" : "A";
    const mutatedSig = sig.slice(0, -1) + replacement;
    const mutated = `${payload}.${mutatedSig}`;

    const claims = verifyHostBrowserCapability(mutated);
    expect(claims).toBeNull();
  });

  test("a malformed token with no `.` separator fails verification", () => {
    const claims = verifyHostBrowserCapability("not-a-token");
    expect(claims).toBeNull();
  });

  test("an expired token fails verification", () => {
    // Mint with a tiny negative TTL so the token is born expired.
    // verifyHostBrowserCapability checks `expiresAt <= Date.now()` and
    // rejects.
    const { token } = mintHostBrowserCapability("guardian-abc", -1);
    const claims = verifyHostBrowserCapability(token);
    expect(claims).toBeNull();
  });

  test("a token issued under one secret fails verification under a different secret", () => {
    // Mint with the current test secret.
    const { token } = mintHostBrowserCapability("guardian-abc");
    // Rotate the secret — the old token's HMAC no longer matches.
    setCapabilityTokenSecretForTests(randomBytes(32));
    const claims = verifyHostBrowserCapability(token);
    expect(claims).toBeNull();
  });

  test("tokens for different guardians carry distinct claims", () => {
    const { token: a } = mintHostBrowserCapability("guardian-a");
    const { token: b } = mintHostBrowserCapability("guardian-b");
    expect(a).not.toBe(b);

    const claimsA = verifyHostBrowserCapability(a);
    const claimsB = verifyHostBrowserCapability(b);
    expect(claimsA?.guardianId).toBe("guardian-a");
    expect(claimsB?.guardianId).toBe("guardian-b");
  });
});

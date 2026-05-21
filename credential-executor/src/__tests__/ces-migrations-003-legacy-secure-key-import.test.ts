import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createLocalSecureKeyBackend } from "../materializers/local-secure-key-backend.js";
import { getManagedCesMigrations } from "../migrations/registry.js";
import { runCesMigrations } from "../migrations/runner.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `ces-legacy-migration-test-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("legacy secure key import migration (003)", () => {
  let tmpDir: string | undefined;
  let savedLegacySecurityDir: string | undefined;

  afterEach(() => {
    if (savedLegacySecurityDir !== undefined) {
      process.env.CREDENTIAL_LEGACY_SECURITY_DIR = savedLegacySecurityDir;
    } else {
      delete process.env.CREDENTIAL_LEGACY_SECURITY_DIR;
    }
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
    savedLegacySecurityDir = undefined;
  });

  function setup() {
    tmpDir = makeTmpDir();
    savedLegacySecurityDir = process.env.CREDENTIAL_LEGACY_SECURITY_DIR;

    const legacyDir = join(tmpDir, "legacy-protected");
    const targetDir = join(tmpDir, "ces-security");
    const cesDataRoot = join(tmpDir, "ces-data");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(cesDataRoot, { recursive: true });

    process.env.CREDENTIAL_LEGACY_SECURITY_DIR = legacyDir;

    const legacyBackend = createLocalSecureKeyBackend(tmpDir!, {
      securityDirOverride: legacyDir,
    });
    const targetBackend = createLocalSecureKeyBackend(tmpDir!, {
      securityDirOverride: targetDir,
    });

    return { cesDataRoot, legacyBackend, targetBackend };
  }

  test("does not append the import migration until the legacy dir is configured", () => {
    savedLegacySecurityDir = process.env.CREDENTIAL_LEGACY_SECURITY_DIR;
    delete process.env.CREDENTIAL_LEGACY_SECURITY_DIR;

    expect(getManagedCesMigrations().map((migration) => migration.id)).toEqual([
      "001-no-op",
      "002-api-keys-to-credentials",
    ]);
  });

  test("imports legacy BYOK keys once and rekeys bare provider keys", async () => {
    const { cesDataRoot, legacyBackend, targetBackend } = setup();

    await legacyBackend.set("anthropic", "legacy-ant");
    await targetBackend.set("credential/vellum/assistant_api_key", "platform");

    await runCesMigrations(
      cesDataRoot,
      targetBackend,
      getManagedCesMigrations(),
    );

    expect(await targetBackend.get("credential/anthropic/api_key")).toBe(
      "legacy-ant",
    );
    expect(await targetBackend.get("anthropic")).toBeUndefined();
    expect(await targetBackend.get("credential/vellum/assistant_api_key")).toBe(
      "platform",
    );

    const checkpoint = JSON.parse(
      readFileSync(join(cesDataRoot, ".ces-migrations.json"), "utf-8"),
    );
    expect(
      checkpoint.applied["003-import-legacy-secure-keys"].status,
    ).toBe("completed");
  });

  test("does not resurrect a CES credential deleted after the import checkpoint", async () => {
    const { cesDataRoot, legacyBackend, targetBackend } = setup();

    await legacyBackend.set("credential/anthropic/api_key", "legacy-ant");

    await runCesMigrations(
      cesDataRoot,
      targetBackend,
      getManagedCesMigrations(),
    );
    expect(await targetBackend.get("credential/anthropic/api_key")).toBe(
      "legacy-ant",
    );

    await targetBackend.delete("credential/anthropic/api_key");

    await runCesMigrations(
      cesDataRoot,
      targetBackend,
      getManagedCesMigrations(),
    );

    expect(
      await targetBackend.get("credential/anthropic/api_key"),
    ).toBeUndefined();
  });
});

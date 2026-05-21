import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { importLegacySecureKeys } from "../legacy-secure-key-import.js";
import { createLocalSecureKeyBackend } from "../materializers/local-secure-key-backend.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `legacy-key-import-test-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("importLegacySecureKeys", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  function setup() {
    tmpDir = makeTmpDir();
    const legacyDir = join(tmpDir, "legacy-protected");
    const targetDir = join(tmpDir, "ces-security");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    const legacyBackend = createLocalSecureKeyBackend(tmpDir!, {
      securityDirOverride: legacyDir,
    });
    const targetBackend = createLocalSecureKeyBackend(tmpDir!, {
      securityDirOverride: targetDir,
    });

    return { legacyDir, legacyBackend, targetBackend };
  }

  test("imports missing legacy keys into an existing CES store", async () => {
    const { legacyDir, legacyBackend, targetBackend } = setup();

    await legacyBackend.set("credential/anthropic/api_key", "legacy-ant");
    await legacyBackend.set("credential/openai/api_key", "legacy-openai");
    await targetBackend.set("credential/vellum/assistant_api_key", "platform");

    const summary = await importLegacySecureKeys({
      legacySecurityDir: legacyDir,
      targetBackend,
    });

    expect(summary).toMatchObject({
      discovered: 2,
      imported: 2,
      skippedExisting: 0,
      unreadable: 0,
      failed: 0,
    });
    expect(await targetBackend.get("credential/anthropic/api_key")).toBe(
      "legacy-ant",
    );
    expect(await targetBackend.get("credential/openai/api_key")).toBe(
      "legacy-openai",
    );
    expect(await targetBackend.get("credential/vellum/assistant_api_key")).toBe(
      "platform",
    );
  });

  test("keeps current values when the CES store already has a key", async () => {
    const { legacyDir, legacyBackend, targetBackend } = setup();

    await legacyBackend.set("credential/anthropic/api_key", "legacy-ant");
    await targetBackend.set("credential/anthropic/api_key", "current-ant");

    const summary = await importLegacySecureKeys({
      legacySecurityDir: legacyDir,
      targetBackend,
    });

    expect(summary.imported).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(await targetBackend.get("credential/anthropic/api_key")).toBe(
      "current-ant",
    );
  });

  test("is a no-op when the legacy store is absent", async () => {
    tmpDir = makeTmpDir();
    const targetDir = join(tmpDir, "ces-security");
    const targetBackend = createLocalSecureKeyBackend(tmpDir, {
      securityDirOverride: targetDir,
    });

    const summary = await importLegacySecureKeys({
      legacySecurityDir: join(tmpDir, "missing"),
      targetBackend,
    });

    expect(summary).toMatchObject({
      discovered: 0,
      imported: 0,
      skippedExisting: 0,
      unreadable: 0,
      failed: 0,
    });
  });
});

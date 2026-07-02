/**
 * Tests for workspace migration `121-seed-default-user-guardrails`.
 *
 * The migration backfills `users/default.md` (the persona rendered for
 * non-guardian actors) with the privacy guardrail. Unlike a plain create-only
 * seed, it also writes over an *empty* file: existing installs seeded an empty
 * `default.md` before the guardrail existed, so blank is the "unmodified"
 * signal we must overwrite. Any real content means the guardian customized the
 * file, so it is left untouched.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { seedDefaultUserGuardrailsMigration } from "../workspace/migrations/121-seed-default-user-guardrails.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-121-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function defaultPath(): string {
  return join(workspaceDir, "users", "default.md");
}

function readDefault(): string {
  return readFileSync(defaultPath(), "utf-8");
}

describe("121-seed-default-user-guardrails migration", () => {
  test("has correct id and description", () => {
    expect(seedDefaultUserGuardrailsMigration.id).toBe(
      "121-seed-default-user-guardrails",
    );
    expect(seedDefaultUserGuardrailsMigration.description).toContain(
      "default.md",
    );
  });

  test("creates users/default.md with the guardrail when absent", () => {
    expect(existsSync(defaultPath())).toBe(false);

    seedDefaultUserGuardrailsMigration.run(workspaceDir);

    expect(existsSync(defaultPath())).toBe(true);
    const content = readDefault();
    // Guardrail body + the trust-class mustache gates the renderer resolves.
    expect(content).toContain("Protect your guardian's privacy");
    expect(content).toContain("{{^isGuardian}}");
    expect(content).toContain("{{#isTrustedContact}}");
    expect(content).toContain("{{#isStranger}}");
  });

  test("backfills an existing EMPTY default.md (the existing-install case)", () => {
    // Older installs seeded a one-byte (newline) default.md.
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), "\n", "utf-8");

    seedDefaultUserGuardrailsMigration.run(workspaceDir);

    expect(readDefault()).toContain("Protect your guardian's privacy");
  });

  test("backfills a whitespace-only default.md", () => {
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), "   \n\t\n", "utf-8");

    seedDefaultUserGuardrailsMigration.run(workspaceDir);

    expect(readDefault()).toContain("Protect your guardian's privacy");
  });

  test("does not clobber a customized default.md", () => {
    const existing = "# My contacts\n\nBe extra chatty with everyone.\n";
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    writeFileSync(defaultPath(), existing, "utf-8");

    seedDefaultUserGuardrailsMigration.run(workspaceDir);

    expect(readDefault()).toBe(existing);
  });

  test("idempotent — second run does not rewrite the seeded file", () => {
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    const afterFirst = readDefault();

    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    const afterSecond = readDefault();

    expect(afterSecond).toBe(afterFirst);
  });

  test("down() is a no-op — seeded file remains", () => {
    seedDefaultUserGuardrailsMigration.run(workspaceDir);
    const seeded = readDefault();

    seedDefaultUserGuardrailsMigration.down(workspaceDir);

    expect(existsSync(defaultPath())).toBe(true);
    expect(readDefault()).toBe(seeded);
  });
});

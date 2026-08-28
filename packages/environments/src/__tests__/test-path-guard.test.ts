import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  assertTestPathIsEphemeral,
  canonicalizePathThroughExistingParent,
  isBunTestProcess,
} from "../test-path-guard.js";

const OPTIONS = {
  allowEnvVar: "TEST_PATH_GUARD_ALLOW",
  runHint: "Run tests from the package root.",
};

describe("isBunTestProcess", () => {
  test("detects this bun test run", () => {
    expect(isBunTestProcess()).toBe(true);
  });
});

describe("canonicalizePathThroughExistingParent", () => {
  test("resolves symlinks on the deepest existing ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "test-path-guard-"));
    try {
      const target = join(root, "target");
      mkdirSync(target);
      const link = join(root, "link");
      symlinkSync(target, link, "dir");
      expect(
        canonicalizePathThroughExistingParent(join(link, "missing", "leaf")),
      ).toBe(
        join(canonicalizePathThroughExistingParent(target), "missing", "leaf"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the input path when no ancestor exists", () => {
    expect(canonicalizePathThroughExistingParent("/nonexistent-root-x/y")).toBe(
      "/nonexistent-root-x/y",
    );
  });
});

describe("assertTestPathIsEphemeral", () => {
  test("allows paths under tmpdir, existing or not", () => {
    expect(() =>
      assertTestPathIsEphemeral(join(tmpdir(), "guard-missing", "x"), OPTIONS),
    ).not.toThrow();
  });

  test("refuses paths outside tmpdir, naming the escape hatch and hint", () => {
    delete process.env[OPTIONS.allowEnvVar];
    const dir = join(homedir(), "test-path-guard-live");
    expect(() => assertTestPathIsEphemeral(dir, OPTIONS)).toThrow(
      /Refusing to use[\s\S]*package root[\s\S]*TEST_PATH_GUARD_ALLOW/,
    );
  });

  test("refuses a tmpdir symlink that resolves outside tmpdir", () => {
    delete process.env[OPTIONS.allowEnvVar];
    const link = join(tmpdir(), `test-path-guard-escape-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(homedir(), link);
    try {
      expect(() => assertTestPathIsEphemeral(link, OPTIONS)).toThrow(
        /Refusing to use/,
      );
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("the allow env var bypasses the guard, per call", () => {
    const dir = join(homedir(), "test-path-guard-optout");
    process.env[OPTIONS.allowEnvVar] = "1";
    try {
      expect(() => assertTestPathIsEphemeral(dir, OPTIONS)).not.toThrow();
    } finally {
      delete process.env[OPTIONS.allowEnvVar];
    }
    expect(() => assertTestPathIsEphemeral(dir, OPTIONS)).toThrow(
      /Refusing to use/,
    );
  });
});

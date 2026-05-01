/**
 * CES CLI integration tests.
 *
 * Exercises the CLI entrypoint (src/cli.ts) against a temporary encrypted
 * key store. Each test gets a fresh temp directory with its own keys.enc
 * and store.key so tests are fully isolated.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");

function makeTempDir(): string {
  const dir = join(tmpdir(), `ces-cli-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(
  args: string[],
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("ces", () => {
  let secDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    secDir = makeTempDir();
    env = { CREDENTIAL_SECURITY_DIR: secDir };
  });

  afterEach(() => {
    rmSync(secDir, { recursive: true, force: true });
  });

  test("list on empty store shows no credentials", () => {
    const { exitCode, stdout } = runCli(["list"], env);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("(no credentials stored)");
  });

  test("set + get round-trip", () => {
    const account = "credential/vellum/platform_organization_id";
    const value = "test-org-uuid-1234";

    const set = runCli(["set", account, value], env);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain(`Set: ${account}`);

    const get = runCli(["get", account], env);
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toBe(value);
  });

  test("list shows stored credentials", () => {
    runCli(["set", "credential/vellum/org_id", "org-1"], env);
    runCli(["set", "credential/vellum/user_id", "user-1"], env);

    const { exitCode, stdout } = runCli(["list"], env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("credential/vellum/org_id");
    expect(stdout).toContain("credential/vellum/user_id");
  });

  test("get on missing key exits 1", () => {
    const { exitCode, stderr } = runCli(["get", "credential/nonexistent/key"], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Not found");
  });

  test("set + delete + get shows not found", () => {
    const account = "credential/test/deleteme";
    runCli(["set", account, "temporary"], env);

    const del = runCli(["delete", account], env);
    expect(del.exitCode).toBe(0);
    expect(del.stdout).toContain("Deleted");

    const get = runCli(["get", account], env);
    expect(get.exitCode).toBe(1);
    expect(get.stderr).toContain("Not found");
  });

  test("delete on missing key exits 1", () => {
    const { exitCode, stderr } = runCli(["delete", "credential/nonexistent/key"], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Not found");
  });

  test("no args prints usage", () => {
    const { exitCode, stdout } = runCli([], env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CES CLI");
    expect(stdout).toContain("ces list");
  });

  test("--help prints usage", () => {
    const { exitCode, stdout } = runCli(["--help"], env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("CES CLI");
  });

  test("unknown command exits 1", () => {
    const { exitCode, stderr } = runCli(["frobnicate"], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  test("set without value exits 1", () => {
    const { exitCode, stderr } = runCli(["set", "credential/test/key"], env);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });

  test("overwrite existing credential", () => {
    const account = "credential/vellum/overwrite_test";
    runCli(["set", account, "first"], env);
    runCli(["set", account, "second"], env);

    const { stdout } = runCli(["get", account], env);
    expect(stdout).toBe("second");
  });
});

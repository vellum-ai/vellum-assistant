import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { clearRuntimeProxyRequireAuthMigration } from "../158-clear-runtime-proxy-require-auth.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "clear-proxy-auth-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("158-clear-runtime-proxy-require-auth", () => {
  test("removes a false value and leaves sibling gateway settings", () => {
    const dir = workspaceWith({
      gateway: { runtimeProxyRequireAuth: false, trustProxy: true },
    });

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readConfig(dir).gateway).toEqual({ trustProxy: true });
  });

  test("removes the string form config also accepts", () => {
    const dir = workspaceWith({
      gateway: { runtimeProxyRequireAuth: "false" },
    });

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readConfig(dir).gateway).toEqual({});
  });

  test("leaves an explicit true alone", () => {
    const dir = workspaceWith({
      gateway: { runtimeProxyRequireAuth: true },
    });

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readConfig(dir).gateway).toEqual({ runtimeProxyRequireAuth: true });
  });

  test("is idempotent", () => {
    const dir = workspaceWith({
      gateway: { runtimeProxyRequireAuth: false },
    });

    clearRuntimeProxyRequireAuthMigration.run(dir);
    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readConfig(dir).gateway).toEqual({});
  });

  test("leaves a workspace with no gateway section untouched", () => {
    const dir = workspaceWith({ other: { keep: 1 } });

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readConfig(dir)).toEqual({ other: { keep: 1 } });
  });

  test("tolerates a missing config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "clear-proxy-auth-"));

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  test("tolerates unparseable config", () => {
    const dir = mkdtempSync(join(tmpdir(), "clear-proxy-auth-"));
    writeFileSync(join(dir, "config.json"), "{not json");

    clearRuntimeProxyRequireAuthMigration.run(dir);

    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{not json");
  });
});

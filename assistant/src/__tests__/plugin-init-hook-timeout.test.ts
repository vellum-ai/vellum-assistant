/**
 * Tests that a slow or hanging plugin `init` hook cannot wedge the daemon.
 *
 * Plugin activation awaits `runInitHook` on the startup path (`bootstrapPlugins`)
 * and inside the mtime-cache reconcile, so an `init` that never resolves — e.g.
 * a plugin that installs a language runtime into a managed venv synchronously —
 * would otherwise stall the rest of startup and every subsequent plugin's
 * activation. `runInitHook` bounds each invocation with a timeout and continues,
 * upholding the "never block startup on a subsystem" rule.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { resetHookCacheForTests, runInitHook } from "../hooks/hook-loader.js";

const ROOT = join(
  tmpdir(),
  `vellum-plugin-init-timeout-${process.pid}-${Date.now()}`,
);
const PLUGINS_DIR = join(ROOT, "plugins");

function writePlugin(name: string, initBody: string): string {
  const dir = join(PLUGINS_DIR, name);
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  writeFileSync(join(hooksDir, "init.ts"), initBody);
  return dir;
}

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
  resetHookCacheForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("runInitHook — timeout resilience", () => {
  test("a hanging init hook resolves via the timeout instead of blocking", async () => {
    // An init that never resolves — the pathological case that wedged startup.
    const dir = writePlugin(
      "slow-init",
      "export default () => new Promise<void>(() => {});\n",
    );

    // Race the bounded call against a generous guard: if the timeout works,
    // runInitHook resolves promptly; a broken timeout would let the guard win
    // (and fail the assertion) instead of hanging the whole test file.
    const outcome = await Promise.race([
      runInitHook("slow-init", dir, { timeoutMs: 50 }).then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("hung"), 2000)),
    ]);

    expect(outcome).toBe("resolved");
  });

  test("a fast init hook still runs to completion", async () => {
    const sentinel = join(ROOT, "ran.txt");
    const dir = writePlugin(
      "fast-init",
      [
        'import { writeFileSync } from "node:fs";',
        "export default async () => {",
        `  writeFileSync(${JSON.stringify(sentinel)}, "ok");`,
        "};",
      ].join("\n"),
    );

    await runInitHook("fast-init", dir, { timeoutMs: 5000 });

    expect(existsSync(sentinel)).toBe(true);
  });

  test("a throwing init hook is swallowed (continues)", async () => {
    const dir = writePlugin(
      "throwing-init",
      'export default async () => { throw new Error("boom"); };\n',
    );

    // Resolves (does not reject) — the failure is logged and swallowed.
    await expect(
      runInitHook("throwing-init", dir, { timeoutMs: 5000 }),
    ).resolves.toBeUndefined();
  });
});

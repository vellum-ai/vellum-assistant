/**
 * Tests for `vellum experimental plugins install`.
 *
 * The command writes to disk, so each test points it at a tmpdir
 * workspace via the `--workspace` flag and exercises end-to-end via the
 * exported `experimental` entrypoint with a mutated `process.argv`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { experimental } from "../commands/experimental";

interface Captured {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exitCode: number | null;
}

interface Harness {
  readonly captured: Captured;
  restore(): void;
}

function installHarness(): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  console.log = ((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  }) as typeof console.log;
  console.error = ((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    // Throw a sentinel so the caller stops; mirrors process.exit semantics.
    throw new ExitSentinel(exitCode);
  }) as typeof process.exit;

  const captured: Captured = {
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
  } as unknown as Captured;

  return {
    captured,
    restore() {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
}

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function run(argvAfterVellum: string[]): Promise<number> {
  const original = process.argv;
  process.argv = ["bun", "vellum", ...argvAfterVellum];
  try {
    await experimental();
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  } finally {
    process.argv = original;
  }
  return 0;
}

function makeSourcePlugin(
  root: string,
  opts: { name: string; withHooks?: boolean; withTools?: boolean; withRegister?: boolean },
): string {
  const dir = join(root, `src-${opts.name.replace(/[^a-z0-9-]/gi, "-")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: opts.name, version: "0.1.0" }, null, 2),
  );
  if (opts.withHooks !== false) {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "init.ts"), "export default async () => {};\n");
  }
  if (opts.withTools) {
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "ping.ts"), "export default { name: 'ping' };\n");
  }
  if (opts.withRegister) {
    writeFileSync(join(dir, "register.ts"), "// legacy\n");
  }
  // A node_modules dir that should be skipped on install.
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "junk", "ignore.txt"), "skip me");
  return dir;
}

describe("vellum experimental plugins install", () => {
  let tmp: string;
  let harness: Harness;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vellum-cli-plugins-install-"));
    harness = installHarness();
  });

  afterEach(() => {
    harness.restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("copies a declarative plugin into <workspace>/plugins/<name>", async () => {
    const source = makeSourcePlugin(tmp, { name: "demo-plugin" });
    const workspace = join(tmp, "ws-plugins");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(0);
    const target = join(workspace, "demo-plugin");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "hooks", "init.ts"))).toBe(true);
    // node_modules must not be copied through.
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(harness.captured.stdout.join("\n")).toContain("Installed plugin");
  });

  test("strips the npm scope from package name when computing target", async () => {
    const source = makeSourcePlugin(tmp, { name: "@vellumai/simple-memory" });
    const workspace = join(tmp, "ws-plugins");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(0);
    expect(existsSync(join(workspace, "simple-memory", "package.json"))).toBe(true);
    expect(existsSync(join(workspace, "@vellumai"))).toBe(false);
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const source = makeSourcePlugin(tmp, { name: "demo-plugin" });
    const workspace = join(tmp, "ws-plugins");
    mkdirSync(join(workspace, "demo-plugin"), { recursive: true });
    writeFileSync(join(workspace, "demo-plugin", "marker"), "existing");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("Target already exists");
    // Marker file from prior install is untouched on refusal.
    expect(readFileSync(join(workspace, "demo-plugin", "marker"), "utf-8")).toBe("existing");
  });

  test("--force replaces an existing install", async () => {
    const source = makeSourcePlugin(tmp, { name: "demo-plugin" });
    const workspace = join(tmp, "ws-plugins");
    mkdirSync(join(workspace, "demo-plugin"), { recursive: true });
    writeFileSync(join(workspace, "demo-plugin", "marker"), "existing");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--force",
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(0);
    expect(existsSync(join(workspace, "demo-plugin", "marker"))).toBe(false);
    expect(existsSync(join(workspace, "demo-plugin", "package.json"))).toBe(true);
  });

  test("rejects a legacy register.ts source", async () => {
    const source = makeSourcePlugin(tmp, {
      name: "legacy-plugin",
      withRegister: true,
    });
    const workspace = join(tmp, "ws-plugins");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("legacy");
    expect(existsSync(join(workspace, "legacy-plugin"))).toBe(false);
  });

  test("rejects a directory with neither hooks/ nor tools/", async () => {
    const source = makeSourcePlugin(tmp, {
      name: "empty-plugin",
      withHooks: false,
    });
    const workspace = join(tmp, "ws-plugins");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      source,
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("hooks/ or tools/");
  });

  test("rejects a missing source directory", async () => {
    const workspace = join(tmp, "ws-plugins");
    const code = await run([
      "experimental",
      "plugins",
      "install",
      join(tmp, "does-not-exist"),
      "--workspace",
      workspace,
    ]);

    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("Source is not a directory");
  });

  test("rejects an empty/invalid package.json name", async () => {
    const dir = join(tmp, "bad-name");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({}));
    writeFileSync(join(dir, "hooks", "init.ts"), "export default async () => {};\n");

    const code = await run([
      "experimental",
      "plugins",
      "install",
      dir,
      "--workspace",
      join(tmp, "ws-plugins"),
    ]);

    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("name");
  });

  test("install --help prints usage and exits 0", async () => {
    const code = await run([
      "experimental",
      "plugins",
      "install",
      "--help",
    ]);
    expect(code).toBe(0);
    expect(harness.captured.stdout.join("\n")).toContain("vellum experimental plugins install");
  });

  test("unknown experimental subcommand exits 1 with help", async () => {
    const code = await run(["experimental", "wat"]);
    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("Unknown experimental subcommand");
  });

  test("unknown plugins subcommand exits 1 with help", async () => {
    const code = await run(["experimental", "plugins", "wat"]);
    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("Unknown experimental plugins subcommand");
  });

  test("plugins install with no source argument exits 1", async () => {
    const code = await run([
      "experimental",
      "plugins",
      "install",
      "--workspace",
      join(tmp, "ws-plugins"),
    ]);
    expect(code).toBe(1);
    expect(harness.captured.stderr.join("\n")).toContain("Missing required argument");
  });
});

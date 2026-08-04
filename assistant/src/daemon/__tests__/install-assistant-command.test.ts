/**
 * Tests for the `assistant` command installer.
 *
 * The two layouts that matter are the compiled desktop bundle (a binary beside
 * the daemon) and the npm-installed runtime the desktop app actually ships (a
 * bun entry under `node_modules`, which needs a wrapper that pins bun). A repo
 * checkout must install nothing: developers own their PATH.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  installCommandAt,
  resolveAssistantCommandTarget,
} from "../install-assistant-command.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assistant-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build `<root>/<prefix>/node_modules/@vellumai/assistant/src/daemon`. */
function seedInstalledLayout(options: { withBin: boolean }): string {
  const nodeModules = join(root, "cli", "latest", "node_modules");
  const moduleDir = join(
    nodeModules,
    "@vellumai",
    "assistant",
    "src",
    "daemon",
  );
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, "..", "index.ts"), "#!/usr/bin/env bun\n");

  if (options.withBin) {
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    writeFileSync(
      join(nodeModules, ".bin", "assistant"),
      "#!/usr/bin/env bun\n",
    );
  }
  return moduleDir;
}

describe("resolveAssistantCommandTarget", () => {
  test("npm install resolves the .bin/assistant shim under a pinned bun", () => {
    const moduleDir = seedInstalledLayout({ withBin: true });

    const target = resolveAssistantCommandTarget({
      execPath: "/Applications/Vellum.app/Contents/Resources/bun",
      moduleDir,
    });

    expect(target).toEqual({
      kind: "bun-entry",
      bun: "/Applications/Vellum.app/Contents/Resources/bun",
      entry: join(root, "cli", "latest", "node_modules", ".bin", "assistant"),
    });
  });

  test("npm install without the meta package falls back to the CLI entry", () => {
    const moduleDir = seedInstalledLayout({ withBin: false });

    const target = resolveAssistantCommandTarget({
      execPath: "/usr/local/bin/bun",
      moduleDir,
    });

    expect(target).toEqual({
      kind: "bun-entry",
      bun: "/usr/local/bin/bun",
      entry: join(
        root,
        "cli",
        "latest",
        "node_modules",
        "@vellumai",
        "assistant",
        "src",
        "index.ts",
      ),
    });
  });

  test("repo checkout installs nothing", () => {
    const moduleDir = join(root, "repo", "assistant", "src", "daemon");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "..", "index.ts"), "#!/usr/bin/env bun\n");

    expect(
      resolveAssistantCommandTarget({
        execPath: "/usr/local/bin/bun",
        moduleDir,
      }),
    ).toBeNull();
  });

  test("compiled bundle resolves the sibling binary", () => {
    const macosDir = join(root, "Vellum.app", "Contents", "MacOS");
    mkdirSync(macosDir, { recursive: true });
    writeFileSync(join(macosDir, "vellum-assistant"), "");

    const target = resolveAssistantCommandTarget({
      execPath: join(macosDir, "vellum-daemon"),
      moduleDir: join(root, "irrelevant"),
    });

    expect(target).toEqual({
      kind: "binary",
      binary: join(macosDir, "vellum-assistant"),
    });
  });

  test("a compiled runtime outside a bundle installs nothing", () => {
    const moduleDir = seedInstalledLayout({ withBin: true });

    expect(
      resolveAssistantCommandTarget({
        execPath: "/opt/vellum/vellum-daemon",
        moduleDir,
      }),
    ).toBeNull();
  });
});

describe("installCommandAt", () => {
  const target = {
    kind: "bun-entry" as const,
    bun: "/Applications/Vellum Staging.app/Contents/Resources/bun",
    entry:
      "/Users/x/Library/Application Support/@vellumai/macos/.bin/assistant",
  };

  test("writes an executable wrapper that quotes paths with spaces", () => {
    const commandPath = join(root, "bin", "assistant");

    expect(installCommandAt(commandPath, target)).toBe(true);

    const content = readFileSync(commandPath, "utf-8");
    expect(content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(content).toContain(
      `exec '/Applications/Vellum Staging.app/Contents/Resources/bun' ` +
        `'/Users/x/Library/Application Support/@vellumai/macos/.bin/assistant' "$@"`,
    );
    expect(lstatSync(commandPath).mode & 0o111).toBeGreaterThan(0);
  });

  test("running the wrapper forwards arguments to the pinned interpreter", () => {
    const interpreter = join(root, "fake bun");
    writeFileSync(interpreter, '#!/bin/sh\necho "$@"\n');
    chmodSync(interpreter, 0o755);

    const commandPath = join(root, "assistant");
    installCommandAt(commandPath, {
      kind: "bun-entry",
      bun: interpreter,
      entry: join(root, "entry with space.ts"),
    });

    const proc = Bun.spawnSync({ cmd: [commandPath, "browser", "status"] });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(
      `${join(root, "entry with space.ts")} browser status`,
    );
  });

  test("is idempotent and rewrites a stale wrapper", () => {
    const commandPath = join(root, "assistant");

    expect(installCommandAt(commandPath, target)).toBe(true);
    const first = readFileSync(commandPath, "utf-8");
    expect(installCommandAt(commandPath, target)).toBe(true);
    expect(readFileSync(commandPath, "utf-8")).toBe(first);

    const moved = { ...target, bun: "/opt/homebrew/bin/bun" };
    expect(installCommandAt(commandPath, moved)).toBe(true);
    expect(readFileSync(commandPath, "utf-8")).toContain(
      "/opt/homebrew/bin/bun",
    );
  });

  test("replaces a stale symlink", () => {
    const commandPath = join(root, "assistant");
    symlinkSync("/nonexistent/old-target", commandPath);

    expect(installCommandAt(commandPath, target)).toBe(true);
    expect(lstatSync(commandPath).isFile()).toBe(true);
  });

  test("never clobbers a file it does not own", () => {
    const commandPath = join(root, "assistant");
    writeFileSync(commandPath, "#!/bin/sh\n# a developer's own build\n");

    expect(installCommandAt(commandPath, target)).toBe(false);
    expect(readFileSync(commandPath, "utf-8")).toContain("developer's own");
  });

  test("reports failure instead of throwing on an unusable path", () => {
    const commandPath = join(root, "assistant");
    mkdirSync(commandPath);

    expect(installCommandAt(commandPath, target)).toBe(false);
    expect(existsSync(commandPath)).toBe(true);
  });

  test("symlinks a compiled binary target", () => {
    const binary = join(root, "vellum-assistant");
    writeFileSync(binary, "");
    const commandPath = join(root, "bin", "assistant");

    expect(installCommandAt(commandPath, { kind: "binary", binary })).toBe(
      true,
    );
    expect(lstatSync(commandPath).isSymbolicLink()).toBe(true);
  });
});

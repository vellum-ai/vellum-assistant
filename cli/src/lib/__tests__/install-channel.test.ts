import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  detectInstallChannel,
  findVellumOnPath,
  WRAPPER_MARKER,
} from "../install-channel.js";

// Mirrors the output of buildWrapperScript() in
// apps/macos/src/main/cli-path-installer.ts.
const WRAPPER_SCRIPT = [
  "#!/bin/sh",
  WRAPPER_MARKER,
  '# Installed by Vellum.app ("Install vellum Command"). Safe to delete.',
  "LOCATOR='/Users/test/Library/Application Support/Vellum/cli/locator.sh'",
  'if [ ! -f "$LOCATOR" ]; then',
  '  echo "vellum: CLI not set up yet. Launch Vellum.app once to finish setup." >&2',
  "  exit 1",
  "fi",
  '. "$LOCATOR"',
  'if [ ! -x "$VELLUM_BUN" ] || [ ! -e "$VELLUM_CLI_BIN" ]; then',
  '  echo "vellum: installation is incomplete. Launch Vellum.app once to repair it." >&2',
  "  exit 1",
  "fi",
  'exec "$VELLUM_BUN" "$VELLUM_CLI_BIN" "$@"',
  "",
].join("\n");

const BUN_SHIM =
  '#!/bin/sh\nexec bun "/Users/test/.bun/install/global/node_modules/vellum/dist/index.js" "$@"\n';

const tempDirs: string[] = [];

function makeBinDir(opts?: { content?: string; mode?: number }): string {
  // realpath so paths derived from process.cwd() (which resolves symlinks,
  // e.g. macOS /var -> /private/var) compare equal.
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "install-channel-test-")),
  );
  tempDirs.push(dir);
  if (opts !== undefined) {
    writeFileSync(path.join(dir, "vellum"), opts.content ?? BUN_SHIM, {
      mode: opts.mode ?? 0o755,
    });
  }
  return dir;
}

function withCwd<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findVellumOnPath", () => {
  test("returns null for an empty PATH", () => {
    const emptyCwd = makeBinDir();
    withCwd(emptyCwd, () => {
      expect(findVellumOnPath("")).toBeNull();
    });
  });

  test("returns null when no entry contains vellum", () => {
    const dir = makeBinDir();
    expect(findVellumOnPath(`${dir}:/nonexistent-dir`)).toBeNull();
  });

  test("first matching entry wins", () => {
    const first = makeBinDir({ content: BUN_SHIM });
    const second = makeBinDir({ content: WRAPPER_SCRIPT });
    expect(findVellumOnPath(`${first}:${second}`)).toBe(
      path.join(first, "vellum"),
    );
  });

  test("treats an empty PATH entry as the cwd (execvp semantics)", () => {
    const cwdWithVellum = makeBinDir({ content: BUN_SHIM });
    const laterDir = makeBinDir({ content: WRAPPER_SCRIPT });
    withCwd(cwdWithVellum, () => {
      expect(findVellumOnPath(`:${laterDir}`)).toBe(
        path.join(cwdWithVellum, "vellum"),
      );
    });
  });

  test("falls through empty PATH entries when the cwd has no vellum", () => {
    const emptyCwd = makeBinDir();
    const dir = makeBinDir({ content: BUN_SHIM });
    withCwd(emptyCwd, () => {
      expect(findVellumOnPath(`::${dir}:`)).toBe(path.join(dir, "vellum"));
    });
  });

  test("skips a non-executable vellum in favor of a later executable one", () => {
    const nonExec = makeBinDir({ content: WRAPPER_SCRIPT, mode: 0o644 });
    const exec = makeBinDir({ content: BUN_SHIM });
    expect(findVellumOnPath(`${nonExec}:${exec}`)).toBe(
      path.join(exec, "vellum"),
    );
  });
});

describe("detectInstallChannel", () => {
  test("classifies the app's wrapper script as app-wrapper", () => {
    const dir = makeBinDir({ content: WRAPPER_SCRIPT });
    expect(detectInstallChannel(dir)).toEqual({
      channel: "app-wrapper",
      binPath: path.join(dir, "vellum"),
    });
  });

  test("classifies a marker-less executable (bun-global shim) as standalone", () => {
    const dir = makeBinDir({ content: BUN_SHIM });
    expect(detectInstallChannel(dir)).toEqual({
      channel: "standalone",
      binPath: path.join(dir, "vellum"),
    });
  });

  test("returns none for an empty PATH", () => {
    const emptyCwd = makeBinDir();
    withCwd(emptyCwd, () => {
      expect(detectInstallChannel("")).toEqual({
        channel: "none",
        binPath: null,
      });
    });
  });

  test("returns none when no vellum exists anywhere on PATH", () => {
    const dir = makeBinDir();
    expect(detectInstallChannel(dir)).toEqual({
      channel: "none",
      binPath: null,
    });
  });

  test("classifies based on the first match when two dirs have vellum", () => {
    const wrapperDir = makeBinDir({ content: WRAPPER_SCRIPT });
    const shimDir = makeBinDir({ content: BUN_SHIM });
    expect(detectInstallChannel(`${wrapperDir}:${shimDir}`)).toEqual({
      channel: "app-wrapper",
      binPath: path.join(wrapperDir, "vellum"),
    });
    expect(detectInstallChannel(`${shimDir}:${wrapperDir}`)).toEqual({
      channel: "standalone",
      binPath: path.join(shimDir, "vellum"),
    });
  });
});

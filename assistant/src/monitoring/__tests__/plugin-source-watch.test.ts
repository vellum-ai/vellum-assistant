/**
 * Tests for the plugin source watcher — the detector half of plugin live
 * reload, driven one pass at a time (no timers) against a controlled
 * workspace.
 *
 * The contract under test is the one sentinel readers rely on:
 *   - the sentinel is rewritten iff plugin source changed (edit, add,
 *     remove, disable-toggle), so its mtime is a change signal;
 *   - the document carries per-directory fingerprints and eviction paths;
 *   - a restarted watcher observing unchanged source adopts the existing
 *     document instead of publishing a spurious change.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

const ROOT = join(
  tmpdir(),
  `plugin-source-watch-test-${process.pid}-${Date.now()}`,
);
const PLUGINS_DIR = join(ROOT, "plugins");
const WORKSPACE_HOOKS_DIR = join(ROOT, "hooks");

beforeAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const { collectSourceVersions, createSourceWatchState, runSourceWatchPass } =
  await import("../plugin-source-watch.js");
const { getSourceVersionsPath, readSourceVersions } =
  await import("../../plugins/source-versions.js");

/** Strictly increasing mtimes so writes never share a timestamp granule. */
let mtimeSeq = 1_750_000_000;
function writeStamped(path: string, content: string): void {
  writeFileSync(path, content);
  const stamp = new Date(++mtimeSeq * 1000);
  utimesSync(path, stamp, stamp);
}

function makePlugin(name: string): string {
  const dir = join(PLUGINS_DIR, name);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeStamped(join(dir, "package.json"), `{"name":${JSON.stringify(name)}}`);
  writeStamped(join(dir, "hooks", "stop.ts"), "export default () => 1;\n");
  writeStamped(join(dir, "lib", "helper.ts"), "export const v = 1;\n");
  return dir;
}

beforeEach(() => {
  rmSync(PLUGINS_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE_HOOKS_DIR, { recursive: true, force: true });
  // The sentinel lives outside the plugins dir, so it must be cleared
  // explicitly between tests.
  rmSync(getSourceVersionsPath(), { force: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });
});

describe("plugin source watch", () => {
  test("the sentinel lives in the monitoring data dir, not the workspace git surface", () => {
    // The document carries absolute host paths; parking it under the
    // plugins dir would let the workspace git service commit it.
    expect(getSourceVersionsPath().startsWith(PLUGINS_DIR)).toBe(false);
    expect(
      getSourceVersionsPath().startsWith(join(ROOT, "data", "monitoring")),
    ).toBe(true);
  });

  test("first pass publishes a baseline covering plugins and workspace hooks", () => {
    const dirA = makePlugin("plugin-a");
    const dirB = makePlugin("plugin-b");
    mkdirSync(WORKSPACE_HOOKS_DIR, { recursive: true });
    writeStamped(join(WORKSPACE_HOOKS_DIR, "stop.ts"), "export default 1;\n");

    const state = createSourceWatchState();
    expect(runSourceWatchPass(state)).toBe(true);

    const doc = readSourceVersions();
    expect(doc).not.toBeNull();
    expect(Object.keys(doc!.plugins).sort()).toEqual(
      [dirA, dirB, WORKSPACE_HOOKS_DIR].sort(),
    );
    expect(doc!.plugins[dirA]!.evictionPaths).toContain(
      join(dirA, "lib", "helper.ts"),
    );
    expect(doc!.plugins[dirA]!.disabled).toBe(false);
    // Atomic write leaves no temp file behind.
    expect(existsSync(`${getSourceVersionsPath()}.tmp`)).toBe(false);
  });

  test("a no-change pass does not rewrite the sentinel", () => {
    makePlugin("plugin-stable");
    const state = createSourceWatchState();
    runSourceWatchPass(state);

    const before = statSync(getSourceVersionsPath()).mtimeMs;
    const generationBefore = readSourceVersions()!.generation;

    expect(runSourceWatchPass(state)).toBe(false);

    expect(statSync(getSourceVersionsPath()).mtimeMs).toBe(before);
    expect(readSourceVersions()!.generation).toBe(generationBefore);
  });

  test("a helper edit rewrites the sentinel with only that plugin's fingerprint moved", () => {
    const dirA = makePlugin("plugin-edit");
    const dirB = makePlugin("plugin-bystander");
    const state = createSourceWatchState();
    runSourceWatchPass(state);
    const before = readSourceVersions()!;

    writeStamped(join(dirA, "lib", "helper.ts"), "export const v = 2;\n");
    expect(runSourceWatchPass(state)).toBe(true);

    const after = readSourceVersions()!;
    expect(after.generation).toBe(before.generation + 1);
    expect(after.plugins[dirA]!.fingerprint).not.toBe(
      before.plugins[dirA]!.fingerprint,
    );
    expect(after.plugins[dirB]!.fingerprint).toBe(
      before.plugins[dirB]!.fingerprint,
    );
  });

  test("a .disabled toggle publishes even though the fingerprint is unchanged", () => {
    const dir = makePlugin("plugin-toggle");
    const state = createSourceWatchState();
    runSourceWatchPass(state);
    const before = readSourceVersions()!;

    writeFileSync(join(dir, ".disabled"), "");
    expect(runSourceWatchPass(state)).toBe(true);

    const after = readSourceVersions()!;
    expect(after.plugins[dir]!.disabled).toBe(true);
    expect(after.plugins[dir]!.fingerprint).toBe(
      before.plugins[dir]!.fingerprint,
    );

    unlinkSync(join(dir, ".disabled"));
    expect(runSourceWatchPass(state)).toBe(true);
    expect(readSourceVersions()!.plugins[dir]!.disabled).toBe(false);
  });

  test("plugin removal and addition are published", () => {
    const dirA = makePlugin("plugin-removed");
    const state = createSourceWatchState();
    runSourceWatchPass(state);

    rmSync(dirA, { recursive: true, force: true });
    expect(runSourceWatchPass(state)).toBe(true);
    expect(readSourceVersions()!.plugins[dirA]).toBeUndefined();

    const dirB = makePlugin("plugin-added");
    expect(runSourceWatchPass(state)).toBe(true);
    expect(readSourceVersions()!.plugins[dirB]).toBeDefined();
  });

  test("a restarted watcher adopts an unchanged sentinel without rewriting", () => {
    makePlugin("plugin-restart");
    const state = createSourceWatchState();
    runSourceWatchPass(state);
    const before = statSync(getSourceVersionsPath()).mtimeMs;
    const generationBefore = readSourceVersions()!.generation;

    // Fresh state, as a new watcher process would build it.
    const restarted = createSourceWatchState();
    expect(runSourceWatchPass(restarted)).toBe(false);

    expect(statSync(getSourceVersionsPath()).mtimeMs).toBe(before);
    expect(readSourceVersions()!.generation).toBe(generationBefore);

    // ...and the adopted generation keeps counting from where it left off.
    writeStamped(
      join(PLUGINS_DIR, "plugin-restart", "lib", "helper.ts"),
      "export const v = 9;\n",
    );
    expect(runSourceWatchPass(restarted)).toBe(true);
    expect(readSourceVersions()!.generation).toBe(generationBefore + 1);
  });

  test("directories without a package.json are not watched as plugins", () => {
    mkdirSync(join(PLUGINS_DIR, "not-a-plugin", "hooks"), { recursive: true });
    writeStamped(
      join(PLUGINS_DIR, "not-a-plugin", "hooks", "stop.ts"),
      "export default 1;\n",
    );

    const versions = collectSourceVersions();
    expect(versions[join(PLUGINS_DIR, "not-a-plugin")]).toBeUndefined();
  });
});

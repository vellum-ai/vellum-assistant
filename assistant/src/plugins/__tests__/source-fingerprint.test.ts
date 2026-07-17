/**
 * Unit tests for the plugin source fingerprint walk: what is included and
 * excluded, which changes move the fingerprint, and how symlinked plugin
 * roots surface in the eviction paths.
 */

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { snapshotPluginSource } from "../source-fingerprint.js";

const root = mkdtempSync(join(tmpdir(), "source-fingerprint-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Writes get explicitly bumped, strictly increasing mtimes so two writes
 * never land inside the same filesystem-timestamp granule.
 */
let mtimeSeq = 1_750_000_000;
function writeStamped(path: string, content: string): void {
  writeFileSync(path, content);
  const stamp = new Date(++mtimeSeq * 1000);
  utimesSync(path, stamp, stamp);
}

let fixtureSeq = 0;
function makePluginDir(): string {
  const dir = join(root, `plugin-${++fixtureSeq}`);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeStamped(join(dir, "hooks", "stop.ts"), `export default () => 1;\n`);
  return dir;
}

describe("snapshotPluginSource", () => {
  test("includes nested source files; excludes node_modules, data/, root sidecars, and dotfiles", () => {
    const dir = makePluginDir();
    mkdirSync(join(dir, "lib", "deep"), { recursive: true });
    writeStamped(join(dir, "lib", "deep", "helper.ts"), "export const x = 1;");
    writeStamped(join(dir, "package.json"), `{"name":"p"}`);

    // Excluded: vendored deps anywhere, runtime data and config sidecars at
    // the root, dot-entries.
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeStamped(join(dir, "node_modules", "dep", "index.js"), "x");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeStamped(join(dir, "data", "state.json"), "{}");
    writeStamped(join(dir, "config.json"), "{}");
    writeStamped(join(dir, "install-meta.json"), "{}");
    writeStamped(join(dir, ".disabled"), "");

    // Included: a nested directory named `data` is source, not the runtime
    // data dir — only the root-level one is excluded.
    mkdirSync(join(dir, "lib", "data"), { recursive: true });
    writeStamped(join(dir, "lib", "data", "table.ts"), "export const t = 1;");

    const { evictionPaths } = snapshotPluginSource(dir);
    const names = evictionPaths.map((p) => p.slice(dir.length));

    expect(names).toContain("/hooks/stop.ts");
    expect(names).toContain("/lib/deep/helper.ts");
    expect(names).toContain("/lib/data/table.ts");
    expect(names).toContain("/package.json");
    expect(names.some((n) => n.includes("node_modules"))).toBe(false);
    expect(names).not.toContain("/data/state.json");
    expect(names).not.toContain("/config.json");
    expect(names).not.toContain("/install-meta.json");
    expect(names).not.toContain("/.disabled");
  });

  test("excludes generated apps/<app>/dist but tracks app src and top-level dist", () => {
    const dir = makePluginDir();
    // App source is tracked.
    mkdirSync(join(dir, "apps", "dash", "src"), { recursive: true });
    writeStamped(
      join(dir, "apps", "dash", "src", "main.tsx"),
      "export default 1;",
    );
    // Generated app build output is excluded (the watcher writes it).
    mkdirSync(join(dir, "apps", "dash", "dist"), { recursive: true });
    writeStamped(
      join(dir, "apps", "dash", "dist", "main.js"),
      "console.log(1)",
    );
    // A plugin's own top-level dist/ is NOT an app build dir — still tracked.
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeStamped(join(dir, "dist", "bundle.js"), "x");

    const names = snapshotPluginSource(dir).evictionPaths.map((p) =>
      p.slice(dir.length),
    );
    expect(names).toContain("/apps/dash/src/main.tsx");
    expect(names).toContain("/dist/bundle.js");
    expect(names).not.toContain("/apps/dash/dist/main.js");

    // Editing the generated dist does not move the fingerprint (no re-trigger)...
    const base = snapshotPluginSource(dir).fingerprint;
    writeStamped(
      join(dir, "apps", "dash", "dist", "main.js"),
      "console.log(2)",
    );
    expect(snapshotPluginSource(dir).fingerprint).toBe(base);

    // ...but editing the app source does.
    writeStamped(
      join(dir, "apps", "dash", "src", "main.tsx"),
      "export default 2;",
    );
    expect(snapshotPluginSource(dir).fingerprint).not.toBe(base);
  });

  test("is stable across identical walks and moves on edit, add, delete, and rename", () => {
    const dir = makePluginDir();
    const helper = join(dir, "hooks", "helper.ts");
    writeStamped(helper, "export const v = 1;");

    const base = snapshotPluginSource(dir).fingerprint;
    expect(snapshotPluginSource(dir).fingerprint).toBe(base);

    // Edit (mtime moves).
    writeStamped(helper, "export const v = 2;");
    const afterEdit = snapshotPluginSource(dir).fingerprint;
    expect(afterEdit).not.toBe(base);

    // Add.
    writeStamped(join(dir, "hooks", "extra.ts"), "export const e = 1;");
    const afterAdd = snapshotPluginSource(dir).fingerprint;
    expect(afterAdd).not.toBe(afterEdit);

    // Rename — same file count, same mtimes, different path set.
    renameSync(
      join(dir, "hooks", "extra.ts"),
      join(dir, "hooks", "renamed.ts"),
    );
    const afterRename = snapshotPluginSource(dir).fingerprint;
    expect(afterRename).not.toBe(afterAdd);

    // Delete.
    unlinkSync(join(dir, "hooks", "renamed.ts"));
    const afterDelete = snapshotPluginSource(dir).fingerprint;
    expect(afterDelete).not.toBe(afterRename);
  });

  test("a symlinked plugin root yields both canonical and alias eviction paths", () => {
    const realDir = makePluginDir();
    const linkDir = join(root, `link-${fixtureSeq}`);
    symlinkSync(realDir, linkDir);

    const { evictionPaths } = snapshotPluginSource(linkDir);

    // The registry may key modules under either form depending on the
    // importer's specifier, so both must be evictable.
    expect(evictionPaths).toContain(join(realDir, "hooks", "stop.ts"));
    expect(evictionPaths).toContain(join(linkDir, "hooks", "stop.ts"));
  });

  test("symlinked entries inside the tree are not followed or watched", () => {
    const dir = makePluginDir();
    // A directory symlink pointing back at the plugin root — following it
    // would cycle the walk forever (or escape the root for links elsewhere).
    symlinkSync(dir, join(dir, "hooks", "loop"));
    // A file symlink: not part of the watched tree either.
    writeStamped(join(dir, "hooks", "real.ts"), "export const r = 1;");
    symlinkSync(join(dir, "hooks", "real.ts"), join(dir, "hooks", "alias.ts"));

    const { evictionPaths } = snapshotPluginSource(dir);
    const names = evictionPaths.map((p) => p.slice(dir.length));

    expect(names).toContain("/hooks/real.ts");
    expect(names).not.toContain("/hooks/alias.ts");
    expect(names.some((n) => n.includes("/loop/"))).toBe(false);
  });

  test("a missing directory yields an empty snapshot", () => {
    const snapshot = snapshotPluginSource(join(root, "does-not-exist"));
    expect(snapshot.fingerprint).toBe("");
    expect(snapshot.evictionPaths).toHaveLength(0);
  });
});

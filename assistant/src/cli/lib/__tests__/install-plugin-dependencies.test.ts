/**
 * Tests for {@link installPluginDependencies}.
 *
 * The dependency install is driven through an injected {@link DependencyInstaller}
 * so no real `bun install` subprocess is spawned: the fake records the directory
 * it was asked to install into (and can inspect the on-disk manifest mid-install)
 * or throws to exercise the fail-soft path. Under test here: the decision to run,
 * the plugin-api-peer strip/restore around the install, and the fail-soft
 * contract; the wiring into the install/upgrade flow is covered by those suites.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEPENDENCY_INSTALL_ARGS,
  type DependencyInstaller,
  installPluginDependencies,
} from "../install-plugin-dependencies.js";

describe("installPluginDependencies", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vellum-plugin-deps-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePkg(pkg: unknown): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }

  test("runs the installer when the plugin declares runtime dependencies", async () => {
    writePkg({ name: "p", dependencies: { "date-fns": "3.0.0" } });
    const calls: string[] = [];
    const run: DependencyInstaller = async ({ cwd }) => {
      calls.push(cwd);
    };

    await installPluginDependencies(dir, run);

    expect(calls).toEqual([dir]);
  });

  test("skips the installer when there are no dependencies", async () => {
    writePkg({ name: "p" });
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    expect(ran).toBe(false);
  });

  test("skips when the dependencies object is empty", async () => {
    writePkg({ name: "p", dependencies: {} });
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    expect(ran).toBe(false);
  });

  test("skips when the package.json is missing", async () => {
    // no package.json written
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    expect(ran).toBe(false);
  });

  test("skips when the package.json is unparseable", async () => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    expect(ran).toBe(false);
  });

  test("does not devDependencies-only trigger an install", async () => {
    writePkg({ name: "p", devDependencies: { typescript: "5.9.3" } });
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    expect(ran).toBe(false);
  });

  test("skips when the only peer is the host-provided plugin-api shim", async () => {
    writePkg({
      name: "p",
      peerDependencies: { "@vellumai/plugin-api": ">=0.8.0" },
    });
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    // Nothing else to install once the shim peer is withheld, so no subprocess.
    expect(ran).toBe(false);
  });

  test("installs a non-host peer (e.g. react) even with no dependencies", async () => {
    writePkg({ name: "p", peerDependencies: { react: "^18.0.0" } });
    let ran = false;
    const run: DependencyInstaller = async () => {
      ran = true;
    };

    await installPluginDependencies(dir, run);

    // A non-host peer is a real runtime import; bun installs peers by default, so
    // the install must run to resolve it.
    expect(ran).toBe(true);
  });

  test("strips only the plugin-api peer during install, then restores the manifest", async () => {
    writePkg({
      name: "p",
      dependencies: { "date-fns": "3.0.0" },
      peerDependencies: { "@vellumai/plugin-api": ">=0.8.0", react: "^18.0.0" },
    });
    const pkgPath = join(dir, "package.json");
    const original = readFileSync(pkgPath, "utf8");

    let peersDuringInstall: Record<string, unknown> | undefined;
    const run: DependencyInstaller = async ({ cwd }) => {
      const parsed = JSON.parse(
        readFileSync(join(cwd, "package.json"), "utf8"),
      );
      peersDuringInstall = parsed.peerDependencies;
    };

    await installPluginDependencies(dir, run);

    // During the install the plugin-api shim is gone but every other peer stays.
    expect(peersDuringInstall).toEqual({ react: "^18.0.0" });
    // Afterward the manifest is restored byte-for-byte so it never reads as drift.
    expect(readFileSync(pkgPath, "utf8")).toBe(original);
  });

  test("restores the manifest even when the install fails", async () => {
    writePkg({
      name: "p",
      dependencies: { "date-fns": "3.0.0" },
      peerDependencies: { "@vellumai/plugin-api": ">=0.8.0" },
    });
    const pkgPath = join(dir, "package.json");
    const original = readFileSync(pkgPath, "utf8");

    const run: DependencyInstaller = async () => {
      throw new Error("network down");
    };

    await installPluginDependencies(dir, run);

    expect(readFileSync(pkgPath, "utf8")).toBe(original);
  });

  test("is fail-soft: an installer error is swallowed, not thrown", async () => {
    writePkg({ name: "p", dependencies: { "date-fns": "3.0.0" } });
    const run: DependencyInstaller = async () => {
      throw new Error("network down");
    };

    // Resolves rather than rejecting — a dep-install failure must never abort
    // the install that already materialized the plugin tree.
    await expect(installPluginDependencies(dir, run)).resolves.toBeUndefined();
  });

  test("bun argv keeps peers (installed by default) and does not blanket-omit them", () => {
    // Peers must NOT be omitted wholesale — a plugin's non-host peer (e.g. react)
    // is a real runtime import. The plugin-api shim is withheld by the manifest
    // strip, not by a flag, so `--omit=peer` must be absent here.
    expect(DEPENDENCY_INSTALL_ARGS).not.toContain("--omit=peer");
    // Runtime deps only (no devDependencies), no lifecycle scripts, and no
    // lockfile / manifest writes.
    expect(DEPENDENCY_INSTALL_ARGS).toEqual([
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-save",
    ]);
  });
});

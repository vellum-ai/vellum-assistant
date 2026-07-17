/**
 * Tests for {@link installPluginDependencies}.
 *
 * The dependency install is driven through an injected {@link DependencyInstaller}
 * so no real `bun install` subprocess is spawned: the fake records the directory
 * it was asked to install into (or throws to exercise the fail-soft path). Only
 * the decision to run — a plugin declares runtime `dependencies` — and the
 * fail-soft contract are under test here; the wiring into the install/upgrade
 * flow is covered by the install/upgrade suites.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
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

  test("is fail-soft: an installer error is swallowed, not thrown", async () => {
    writePkg({ name: "p", dependencies: { "date-fns": "3.0.0" } });
    const run: DependencyInstaller = async () => {
      throw new Error("network down");
    };

    // Resolves rather than rejecting — a dep-install failure must never abort
    // the install that already materialized the plugin tree.
    await expect(installPluginDependencies(dir, run)).resolves.toBeUndefined();
  });
});

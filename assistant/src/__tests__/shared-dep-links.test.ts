/**
 * Smoke tests for the shared-dep symlink linker.
 *
 *   - each whitelisted dep resolves to a real on-disk package directory
 *   - a symlink is created at <workspace>/node_modules/<dep> pointing to it
 *   - a fake plugin under <workspace>/plugins/ can import AND use the dep
 *     (z.object().parse round-trip), proving the end-to-end path a real
 *     installed plugin exercises — the installer never runs `bun install`,
 *     so this symlink is the only way a plugin's zod import resolves
 *   - re-runs are idempotent (existing links are not clobbered)
 *   - a pre-existing real package at the target path is left untouched
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const ZOD_REL_PATH = "node_modules/zod";

describe("ensureSharedDepLinks", () => {
  // Ensure each test gets a fresh import of the linker, since the module
  // reads getWorkspaceDir() (backed by VELLUM_WORKSPACE_DIR) at call time
  // but the module itself may be cached across tests.
  let prevWorkspaceDir: string | undefined;

  afterEach(() => {
    if (prevWorkspaceDir !== undefined) {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    } else {
      delete process.env.VELLUM_WORKSPACE_DIR;
    }
  });

  async function importLinker() {
    // Dynamic import so VELLUM_WORKSPACE_DIR is read fresh each time.
    return await import("../plugins/ensure-shared-dep-links.js");
  }

  test("each whitelisted dep is resolvable on disk", () => {
    // In the test environment (JIT, not compiled), zod must resolve to a
    // real directory. A failure here means the dep is missing from the
    // assistant's dependencies or the resolver is broken.
    expect(() => require.resolve("zod")).not.toThrow();
  });

  test("symlinks the real zod package into workspace node_modules", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;

    const { ensureSharedDepLinks } = await importLinker();
    await ensureSharedDepLinks();

    const linkPath = join(workspaceDir, ZOD_REL_PATH);
    expect(existsSync(linkPath)).toBe(true);
    // The symlink target is the real zod package, not a generated shim.
    expect(existsSync(join(linkPath, "package.json"))).toBe(true);
    const pkg = JSON.parse(
      await readFile(join(linkPath, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("zod");
  });

  test("a fake user plugin can import and USE zod via the symlink", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;

    const { ensureSharedDepLinks } = await importLinker();
    await ensureSharedDepLinks();

    const pluginDir = join(workspaceDir, "plugins", "fake-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "probe.js"),
      `import { z } from "zod";\n` +
        `const schema = z.object({ port: z.number().int().default(8790) });\n` +
        `export const parsed = schema.parse({});\n`,
    );

    // Resolution walks up: plugins/fake-plugin → plugins → workspaceDir →
    // workspaceDir/node_modules/zod (symlink) → real zod. The parse() call
    // proves the symlink points to the live library, not a stub.
    const mod: { parsed: { port: number } } = await import(
      join(pluginDir, "probe.js")
    );
    expect(mod.parsed.port).toBe(8790);
  });

  test("is idempotent — existing links are not clobbered", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;

    const { ensureSharedDepLinks } = await importLinker();
    await ensureSharedDepLinks();
    const linkPath = join(workspaceDir, ZOD_REL_PATH);
    const first = await readFile(join(linkPath, "package.json"), "utf8");

    await ensureSharedDepLinks();
    const second = await readFile(join(linkPath, "package.json"), "utf8");
    expect(second).toBe(first);
  });

  test("leaves a pre-existing real package untouched", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    const realDir = join(workspaceDir, ZOD_REL_PATH);
    await mkdir(realDir, { recursive: true });
    const realPkg = JSON.stringify({ name: "zod", version: "9.9.9" });
    await writeFile(join(realDir, "package.json"), realPkg);

    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;

    const { ensureSharedDepLinks } = await importLinker();
    await ensureSharedDepLinks();

    const after = await readFile(join(realDir, "package.json"), "utf8");
    expect(after).toBe(realPkg);
  });
});

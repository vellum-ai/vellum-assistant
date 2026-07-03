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
import { describe, expect, test } from "bun:test";

import { SHARED_DEPS } from "../embedded/shared-deps.js";
import { ensureSharedDepLinks } from "../plugins/ensure-shared-dep-links.js";

const ZOD_REL_PATH = "node_modules/zod";

describe("ensureSharedDepLinks", () => {
  test("each whitelisted dep is resolvable on disk", () => {
    // In the test environment (JIT, not compiled), every whitelisted dep
    // must resolve to a real directory. A failure here means the dep is
    // missing from the assistant's dependencies or the resolver is broken.
    for (const name of SHARED_DEPS) {
      expect(() => require.resolve(name)).not.toThrow();
    }
  });

  test("symlinks the real zod package into workspace node_modules", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    await ensureSharedDepLinks({ workspaceDir });

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
    await ensureSharedDepLinks({ workspaceDir });

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
    await ensureSharedDepLinks({ workspaceDir });
    const linkPath = join(workspaceDir, ZOD_REL_PATH);
    const first = await readFile(join(linkPath, "package.json"), "utf8");

    await ensureSharedDepLinks({ workspaceDir });
    const second = await readFile(join(linkPath, "package.json"), "utf8");
    expect(second).toBe(first);
  });

  test("leaves a pre-existing real package untouched", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "shared-dep-links-"));
    const realDir = join(workspaceDir, ZOD_REL_PATH);
    await mkdir(realDir, { recursive: true });
    const realPkg = JSON.stringify({ name: "zod", version: "9.9.9" });
    await writeFile(join(realDir, "package.json"), realPkg);

    await ensureSharedDepLinks({ workspaceDir });

    const after = await readFile(join(realDir, "package.json"), "utf8");
    expect(after).toBe(realPkg);
  });
});

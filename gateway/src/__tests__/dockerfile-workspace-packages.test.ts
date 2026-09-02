import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The gateway image copies workspace package sources after `bun install`.
 * A declared `workspace:*` dependency that is not COPYed boots as
 * `Cannot find module '@vellumai/<name>'`.
 */
describe("gateway Dockerfile workspace packages", () => {
  test("copies every workspace dependency into the image", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "gateway/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dockerfile = readFileSync(
      join(repoRoot, "gateway/Dockerfile"),
      "utf8",
    );

    const missing: string[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version !== "workspace:*") {
        continue;
      }
      if (!name.startsWith("@vellumai/")) {
        missing.push(`${name} (unexpected workspace package)`);
        continue;
      }
      const dir = `packages/${name.slice("@vellumai/".length)}`;
      if (!dockerfile.includes(`COPY --chown=gateway:gateway ${dir} `)) {
        missing.push(dir);
      }
    }

    expect(missing).toEqual([]);
  });
});

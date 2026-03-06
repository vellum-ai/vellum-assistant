/**
 * Third-party package resolver with an allowlist for app builds.
 *
 * Maintains a shared cache at ~/.vellum/package-cache/ so packages are
 * installed once and reused across all app compilations.
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";

const log = getLogger("package-resolver");

/** Packages the model is likely to use and that we trust in sandboxed apps. */
export const ALLOWED_PACKAGES: readonly string[] = [
  "date-fns",
  "chart.js",
  "lodash-es",
  "zod",
  "clsx",
  "lucide",
] as const;

const INSTALL_TIMEOUT_MS = 10_000;
const MAX_PACKAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Where all cached packages live on disk. */
export function getCacheDir(): string {
  return join(homedir(), ".vellum", "package-cache");
}

/**
 * Return true when `name` is a bare specifier that our plugin should handle
 * (i.e. not a relative/absolute path, not preact/react which are aliased).
 */
export function isBareImport(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("/")) return false;
  if (name.startsWith("preact") || name === "react" || name === "react-dom") {
    return false;
  }
  return true;
}

/** Get the top-level package name from a specifier (handles scoped pkgs). */
export function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

/**
 * Resolve a third-party package from the shared cache.
 *
 * Returns the path to the package inside node_modules, or null if the
 * package is not allowed or installation failed.
 */
export async function resolvePackage(name: string): Promise<string | null> {
  const pkg = packageName(name);

  if (!ALLOWED_PACKAGES.includes(pkg)) {
    return null;
  }

  const cacheDir = getCacheDir();
  const nodeModulesDir = join(cacheDir, "node_modules");
  const pkgDir = join(nodeModulesDir, pkg);

  // Already cached — skip install
  if (existsSync(pkgDir)) {
    return nodeModulesDir;
  }

  // Ensure cache directory exists with a package.json so bun install works
  await mkdir(cacheDir, { recursive: true });
  const pkgJsonPath = join(cacheDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      pkgJsonPath,
      JSON.stringify({ name: "vellum-pkg-cache", private: true }),
    );
  }

  log.info({ pkg }, "Installing package into shared cache");

  try {
    const proc = Bun.spawn(["bun", "install", "--no-save", pkg], {
      cwd: cacheDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${homedir()}/.bun/bin:${process.env.PATH}`,
      },
    });

    // Race against timeout
    const exited = proc.exited;
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), INSTALL_TIMEOUT_MS),
    );

    const raceResult = await Promise.race([exited, timeout]);

    if (raceResult === "timeout") {
      proc.kill();
      log.warn({ pkg }, "Package install timed out");
      return null;
    }

    if (raceResult !== 0) {
      const stderr = await new Response(proc.stderr).text();
      log.warn({ pkg, stderr }, "Package install failed");
      return null;
    }

    // Enforce max size
    if (existsSync(pkgDir)) {
      const size = await dirSize(pkgDir);
      if (size > MAX_PACKAGE_SIZE_BYTES) {
        log.warn({ pkg, size }, "Package exceeds size limit, removing");
        const { rm } = await import("node:fs/promises");
        await rm(pkgDir, { recursive: true, force: true });
        return null;
      }
    }

    return existsSync(pkgDir) ? nodeModulesDir : null;
  } catch (err) {
    log.warn({ pkg, err }, "Package resolution failed");
    return null;
  }
}

/** Recursively sum file sizes under a directory. */
async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      const s = await stat(full);
      total += s.size;
    }
  }
  return total;
}

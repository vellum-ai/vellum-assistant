/**
 * Third-party package resolver with an allowlist for app builds.
 *
 * Maintains a shared cache at ~/.vellum/package-cache/ so packages are
 * installed once and reused across all app compilations.
 *
 * Uses direct npm tarball download (no `bun install` dependency) so
 * resolution works reliably inside compiled binaries where a standalone
 * `bun` CLI may not be on PATH.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
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

const INSTALL_TIMEOUT_MS = 15_000;
const MAX_PACKAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** In-flight install promises keyed by package name, to deduplicate concurrent requests. */
const inflight = new Map<string, Promise<string | null>>();

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
  if (
    name.startsWith("preact") ||
    name.startsWith("react") ||
    name.startsWith("react-dom")
  ) {
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
    log.warn({ pkg }, "Package not in allowlist, skipping");
    return null;
  }

  const cacheDir = getCacheDir();
  const nodeModulesDir = join(cacheDir, "node_modules");
  const pkgDir = join(nodeModulesDir, pkg);

  // Already cached — skip install
  if (existsSync(pkgDir)) {
    return nodeModulesDir;
  }

  // Deduplicate concurrent install requests for the same package
  const existing = inflight.get(pkg);
  if (existing) {
    return existing;
  }

  const promise = installPackage(pkg, nodeModulesDir, pkgDir);
  inflight.set(pkg, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(pkg);
  }
}

// ---------------------------------------------------------------------------
// npm tarball download (no `bun` CLI dependency)
// ---------------------------------------------------------------------------

interface NpmDistMeta {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

/**
 * Fetch the latest version metadata for a package from the npm registry
 * and return the tarball URL + integrity hash.
 */
async function fetchPackageMeta(
  pkg: string,
): Promise<{ tarballUrl: string; integrity: string }> {
  const encoded = pkg.replace("/", "%2f");
  const url = `https://registry.npmjs.org/${encoded}/latest`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `npm registry metadata fetch failed for ${pkg}: ${res.status} ${res.statusText}`,
    );
  }

  const data = (await res.json()) as { dist?: NpmDistMeta };
  const dist = data.dist;
  if (!dist?.tarball) {
    throw new Error(`Missing tarball URL in npm metadata for ${pkg}`);
  }

  let integrity: string;
  if (typeof dist.integrity === "string" && dist.integrity.length > 0) {
    integrity = dist.integrity;
  } else if (typeof dist.shasum === "string" && dist.shasum.length > 0) {
    integrity = `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`;
  } else {
    throw new Error(`Missing integrity metadata for ${pkg}`);
  }

  return { tarballUrl: dist.tarball, integrity };
}

/** Verify a tarball against its npm integrity hash. */
function verifyIntegrity(
  tarball: Uint8Array,
  integrity: string,
  pkg: string,
): void {
  const [algorithm, expectedDigest] = integrity.split("-", 2);
  if (!algorithm || !expectedDigest) {
    throw new Error(`Invalid integrity format for ${pkg}: ${integrity}`);
  }
  if (algorithm !== "sha512" && algorithm !== "sha1") {
    throw new Error(`Unsupported integrity algorithm ${algorithm} for ${pkg}`);
  }
  const actualDigest = createHash(algorithm).update(tarball).digest("base64");
  if (actualDigest !== expectedDigest) {
    throw new Error(`Integrity verification failed for ${pkg}`);
  }
}

/**
 * Download and install a single package via direct npm tarball fetch.
 *
 * Downloads the tarball, verifies integrity, extracts into the shared
 * node_modules cache, and enforces size limits.  Does NOT depend on
 * `bun` or any other package-manager CLI being on PATH.
 */
async function installPackage(
  pkg: string,
  nodeModulesDir: string,
  pkgDir: string,
): Promise<string | null> {
  log.info({ pkg }, "Downloading package from npm registry");

  try {
    // Fetch metadata + tarball URL from npm
    const { tarballUrl, integrity } = await withTimeout(
      fetchPackageMeta(pkg),
      INSTALL_TIMEOUT_MS,
      `npm metadata fetch timed out for ${pkg}`,
    );

    // Download tarball (timeout covers headers + full body read)
    const tarball = await withTimeout(
      fetch(tarballUrl).then(async (res) => {
        if (!res.ok) {
          throw new Error(`npm tarball download failed (${res.status})`);
        }
        return new Uint8Array(await res.arrayBuffer());
      }),
      INSTALL_TIMEOUT_MS,
      `npm tarball download timed out for ${pkg}`,
    );
    verifyIntegrity(tarball, integrity, pkg);

    // Extract into node_modules/<pkg>/
    mkdirSync(pkgDir, { recursive: true });
    const tmpTar = join(pkgDir, `download-${Date.now()}.tgz`);
    writeFileSync(tmpTar, Buffer.from(tarball));

    try {
      const proc = Bun.spawn({
        cmd: ["tar", "xzf", tmpTar, "-C", pkgDir, "--strip-components=1"],
        stdout: "ignore",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`tar extraction failed for ${pkg}: ${stderr}`);
      }
    } finally {
      try {
        rmSync(tmpTar);
      } catch {
        /* ignore cleanup failure */
      }
    }

    // Enforce max size
    const size = await dirSize(pkgDir);
    if (size > MAX_PACKAGE_SIZE_BYTES) {
      log.warn({ pkg, size }, "Package exceeds size limit, removing");
      await rm(pkgDir, { recursive: true, force: true });
      return null;
    }

    log.info({ pkg }, "Package installed successfully");
    return nodeModulesDir;
  } catch (err) {
    log.warn({ pkg, err }, "Package resolution failed");
    // Clean up partial install
    try {
      if (existsSync(pkgDir)) {
        rmSync(pkgDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Race a promise against a timeout. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Recursively sum file sizes under a directory. */
async function dirSize(dir: string): Promise<number> {
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

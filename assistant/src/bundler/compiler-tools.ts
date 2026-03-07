/**
 * JIT download and cache of esbuild binary + preact for app compilation.
 *
 * Instead of shipping these in the .app bundle (~11 MB), we download them
 * on first compile to ~/.vellum/workspace/compiler-tools/. Follows the
 * same pattern as EmbeddingRuntimeManager.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { PromiseGuard } from "../util/promise-guard.js";

const log = getLogger("compiler-tools");

// Pinned versions matching assistant/bun.lock
const ESBUILD_VERSION = "0.24.2";
const PREACT_VERSION = "10.28.4";

const TOOLS_VERSION = `esbuild-${ESBUILD_VERSION}_preact-${PREACT_VERSION}`;

export interface CompilerTools {
  esbuildBin: string;
  preactDir: string;
}

interface VersionManifest {
  toolsVersion: string;
  esbuildVersion: string;
  preactVersion: string;
  platform: string;
  arch: string;
  installedAt: string;
}

function getToolsDir(): string {
  return join(homedir(), ".vellum", "workspace", "compiler-tools");
}

const installGuard = new PromiseGuard<void>();

function npmTarballUrl(pkg: string, version: string): string {
  const encoded = pkg.replace("/", "%2f");
  const basename = pkg.startsWith("@") ? pkg.split("/")[1] : pkg;
  return `https://registry.npmjs.org/${encoded}/-/${basename}-${version}.tgz`;
}

async function downloadAndExtract(
  url: string,
  targetDir: string,
): Promise<void> {
  log.info({ url, targetDir }, "Downloading npm package");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const tarball = await response.arrayBuffer();
  mkdirSync(targetDir, { recursive: true });

  const tmpTar = join(targetDir, `download-${Date.now()}.tgz`);
  writeFileSync(tmpTar, Buffer.from(tarball));

  try {
    const proc = Bun.spawn({
      cmd: ["tar", "xzf", tmpTar, "-C", targetDir, "--strip-components=1"],
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract ${url}: ${stderr}`);
    }
  } finally {
    try {
      rmSync(tmpTar);
    } catch {
      /* ignore */
    }
  }
}

function readManifest(baseDir: string): VersionManifest | null {
  const manifestPath = join(baseDir, "version.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function isReady(baseDir: string): boolean {
  const manifest = readManifest(baseDir);
  if (!manifest || manifest.toolsVersion !== TOOLS_VERSION) return false;
  return (
    existsSync(join(baseDir, "bin", "esbuild")) &&
    existsSync(join(baseDir, "node_modules", "preact"))
  );
}

/**
 * Ensure esbuild binary + preact are downloaded and cached.
 * Safe to call concurrently — deduplicates via PromiseGuard.
 */
export async function ensureCompilerTools(): Promise<CompilerTools> {
  const baseDir = getToolsDir();

  if (!isReady(baseDir)) {
    await installGuard.run(() => install(baseDir));
    if (!isReady(baseDir)) {
      installGuard.reset();
      throw new Error("Compiler tools installation failed");
    }
  }

  return {
    esbuildBin: join(baseDir, "bin", "esbuild"),
    preactDir: join(baseDir, "node_modules", "preact"),
  };
}

async function install(baseDir: string): Promise<void> {
  if (isReady(baseDir)) return;

  const os = platform();
  const cpu = arch();
  log.info(
    { os, cpu, toolsVersion: TOOLS_VERSION },
    "Installing compiler tools",
  );

  mkdirSync(baseDir, { recursive: true });

  // Lock file to prevent concurrent cross-process installs
  const lockPath = join(baseDir, ".downloading");
  if (existsSync(lockPath)) {
    try {
      const lockPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(lockPid) && lockPid !== process.pid) {
        try {
          process.kill(lockPid, 0);
          log.info(
            { lockPid },
            "Another process is installing compiler tools, waiting",
          );
          // Wait up to 60s for the other process to finish
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            if (isReady(baseDir)) return;
          }
          log.warn("Timed out waiting for other installer, proceeding");
        } catch {
          log.info({ lockPid }, "Cleaning up stale compiler tools lock");
        }
      }
    } catch {
      // Can't read lock, proceed
    }
  }

  writeFileSync(lockPath, String(process.pid));

  const tmpDir = join(baseDir, `.installing-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Determine esbuild platform package name
    const esbuildPlatform =
      os === "darwin"
        ? cpu === "arm64"
          ? "darwin-arm64"
          : "darwin-x64"
        : cpu === "arm64"
          ? "linux-arm64"
          : "linux-x64";

    // Download esbuild binary + preact in parallel
    await Promise.all([
      downloadAndExtract(
        npmTarballUrl(`@esbuild/${esbuildPlatform}`, ESBUILD_VERSION),
        join(tmpDir, "esbuild-pkg"),
      ),
      downloadAndExtract(
        npmTarballUrl("preact", PREACT_VERSION),
        join(tmpDir, "node_modules", "preact"),
      ),
    ]);

    // Move esbuild binary to bin/
    const esbuildBinSrc = join(tmpDir, "esbuild-pkg", "bin", "esbuild");
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(esbuildBinSrc, join(binDir, "esbuild"));
    chmodSync(join(binDir, "esbuild"), 0o755);
    rmSync(join(tmpDir, "esbuild-pkg"), { recursive: true, force: true });

    // Write version manifest
    const manifest: VersionManifest = {
      toolsVersion: TOOLS_VERSION,
      esbuildVersion: ESBUILD_VERSION,
      preactVersion: PREACT_VERSION,
      platform: os,
      arch: cpu,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(tmpDir, "version.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    // Atomic swap: clear old install, move new files in
    const { readdirSync } = await import("node:fs");
    for (const entry of readdirSync(baseDir)) {
      if (entry.startsWith(".") || entry === tmpDir.split("/").pop()) continue;
      rmSync(join(baseDir, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(tmpDir)) {
      renameSync(join(tmpDir, entry), join(baseDir, entry));
    }

    log.info({ toolsVersion: TOOLS_VERSION }, "Compiler tools installed");
  } catch (err) {
    log.error({ err }, "Failed to install compiler tools");
    throw err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      rmSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

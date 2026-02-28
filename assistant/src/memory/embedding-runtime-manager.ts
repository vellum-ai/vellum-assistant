/**
 * Downloads and manages the local embedding runtime (onnxruntime-node +
 * @huggingface/transformers) post-hatch.
 *
 * Instead of shipping these heavy native + JS dependencies inside the .app
 * bundle, we download them from the npm registry after the daemon starts.
 * The runtime is stored in ~/.vellum/workspace/embedding-models/ and loaded
 * by embedding-local.ts on demand.
 *
 * Follows the same download/install pattern as qdrant-manager.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';

import { getLogger } from '../util/logger.js';
import { getEmbeddingModelsDir } from '../util/platform.js';

const log = getLogger('embedding-runtime-manager');

// Pinned versions matching assistant/bun.lock
const ONNXRUNTIME_NODE_VERSION = '1.21.0';
const ONNXRUNTIME_COMMON_VERSION = '1.21.0';
const TRANSFORMERS_VERSION = '3.8.1';

/** Composite version string for cache invalidation. */
const RUNTIME_VERSION = `ort-${ONNXRUNTIME_NODE_VERSION}_hf-${TRANSFORMERS_VERSION}`;

interface VersionManifest {
  runtimeVersion: string;
  onnxruntimeNodeVersion: string;
  onnxruntimeCommonVersion: string;
  transformersVersion: string;
  platform: string;
  arch: string;
  installedAt: string;
}

// ── npm tarball helpers ─────────────────────────────────────────────

function npmTarballUrl(pkg: string, version: string): string {
  // Scoped packages encode the scope in the URL
  const encoded = pkg.replace('/', '%2f');
  const basename = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
  return `https://registry.npmjs.org/${encoded}/-/${basename}-${version}.tgz`;
}

async function downloadAndExtract(
  url: string,
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  log.info({ url, targetDir }, 'Downloading npm package');

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const tarball = await response.arrayBuffer();

  // npm tarballs extract to package/, we need to redirect to targetDir
  mkdirSync(targetDir, { recursive: true });

  const tmpTar = join(targetDir, `download-${Date.now()}.tgz`);
  writeFileSync(tmpTar, Buffer.from(tarball));

  try {
    // Extract tarball, stripping the leading "package/" directory
    const proc = Bun.spawn({
      cmd: ['tar', 'xzf', tmpTar, '-C', targetDir, '--strip-components=1'],
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract ${url}: ${stderr}`);
    }
  } finally {
    try { rmSync(tmpTar); } catch { /* ignore */ }
  }
}

// ── Main manager ────────────────────────────────────────────────────

export class EmbeddingRuntimeManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? getEmbeddingModelsDir();
  }

  /** Check if the embedding runtime is installed and up-to-date. */
  isReady(): boolean {
    const manifest = this.readManifest();
    if (!manifest) return false;
    if (manifest.runtimeVersion !== RUNTIME_VERSION) return false;

    // Verify the bundle file exists
    const bundlePath = this.getBundlePath();
    return existsSync(bundlePath);
  }

  /** Path to the pre-built transformers bundle. */
  getBundlePath(): string {
    return join(this.baseDir, 'dist', 'transformers-bundle.mjs');
  }

  /**
   * Download and install the embedding runtime if not already present.
   * Safe to call concurrently — uses a lock file to prevent duplicate downloads.
   */
  async ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (this.isReady()) {
      log.info('Embedding runtime already installed and up-to-date');
      return;
    }

    // Simple lock to prevent concurrent downloads
    const lockPath = join(this.baseDir, '.downloading');
    if (existsSync(lockPath)) {
      try {
        const lockContent = readFileSync(lockPath, 'utf-8').trim();
        const lockPid = parseInt(lockContent, 10);
        if (!isNaN(lockPid) && lockPid !== process.pid) {
          // Check if the other process is still alive
          try {
            process.kill(lockPid, 0);
            log.info({ lockPid }, 'Another process is downloading the embedding runtime, skipping');
            return;
          } catch {
            // Process is dead, clean up stale lock
            log.info({ lockPid }, 'Cleaning up stale download lock');
          }
        }
      } catch {
        // Can't read lock file, proceed
      }
    }

    // Acquire lock
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(lockPath, String(process.pid));

    try {
      await this.install(signal);
    } finally {
      try { rmSync(lockPath); } catch { /* ignore */ }
    }
  }

  private async install(signal?: AbortSignal): Promise<void> {
    const os = platform();
    const cpu = arch();
    log.info({ os, cpu, runtimeVersion: RUNTIME_VERSION }, 'Installing embedding runtime');

    // Work in a temp directory for atomic install
    const tmpDir = join(this.baseDir, `.installing-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      // Step 1: Download npm packages
      const nodeModules = join(tmpDir, 'node_modules');

      await Promise.all([
        downloadAndExtract(
          npmTarballUrl('onnxruntime-node', ONNXRUNTIME_NODE_VERSION),
          join(nodeModules, 'onnxruntime-node'),
          signal,
        ),
        downloadAndExtract(
          npmTarballUrl('onnxruntime-common', ONNXRUNTIME_COMMON_VERSION),
          join(nodeModules, 'onnxruntime-common'),
          signal,
        ),
        downloadAndExtract(
          npmTarballUrl('@huggingface/transformers', TRANSFORMERS_VERSION),
          join(nodeModules, '@huggingface', 'transformers'),
          signal,
        ),
      ]);

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      log.info('npm packages downloaded, stripping non-platform binaries');

      // Step 2: Strip non-platform native binaries
      const onnxBinDir = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3');
      if (existsSync(onnxBinDir)) {
        const entries = readdirSync(onnxBinDir);
        for (const entry of entries) {
          // Keep all darwin architectures (arm64 and x86_64) since uname -m
          // is unreliable under Rosetta (returns x86_64 on Apple Silicon)
          if (entry !== os) {
            rmSync(join(onnxBinDir, entry), { recursive: true, force: true });
          }
        }
      }

      // Strip non-runtime files to reduce disk usage
      const onnxNodeDir = join(nodeModules, 'onnxruntime-node');
      for (const dir of ['script', 'lib']) {
        rmSync(join(onnxNodeDir, dir), { recursive: true, force: true });
      }
      rmSync(join(onnxNodeDir, 'README.md'), { force: true });
      rmSync(join(nodeModules, 'onnxruntime-common', 'lib'), { recursive: true, force: true });
      rmSync(join(nodeModules, 'onnxruntime-common', 'README.md'), { force: true });

      // Step 3: Bundle transformers with Bun.build()
      // This solves the CJS/ESM dual-instance issue between onnxruntime-node
      // and @huggingface/transformers by combining all JS deps into one file.
      // Native .node binaries are left external.
      log.info('Creating transformers bundle with Bun.build()');

      const entryFile = join(tmpDir, '_bundle-entry.js');
      writeFileSync(entryFile, 'export * from "@huggingface/transformers";\n');

      // The bundle must live inside onnxruntime-node/dist/ so that the
      // externalized require('../bin/napi-v3/...') paths resolve correctly.
      const bundleOutDir = join(nodeModules, 'onnxruntime-node', 'dist');
      mkdirSync(bundleOutDir, { recursive: true });

      const buildResult = await Bun.build({
        entrypoints: [entryFile],
        outdir: bundleOutDir,
        target: 'node',
        format: 'esm',
        external: ['*.node'],
        naming: 'transformers-bundle.mjs',
      });

      if (!buildResult.success) {
        const errors = buildResult.logs.map((l: { message?: string }) => l.message ?? String(l)).join('\n');
        throw new Error(`Bun.build() failed:\n${errors}`);
      }

      rmSync(entryFile, { force: true });

      // Step 4: Set up final directory structure
      // dist/transformers-bundle.mjs → mirrors onnxruntime-node/dist/
      // bin/ → mirrors onnxruntime-node/bin/
      const finalDistDir = join(tmpDir, 'dist');
      const finalBinDir = join(tmpDir, 'bin');

      mkdirSync(finalDistDir, { recursive: true });
      renameSync(
        join(bundleOutDir, 'transformers-bundle.mjs'),
        join(finalDistDir, 'transformers-bundle.mjs'),
      );

      // Copy native binaries to bin/ (mirrors onnxruntime-node/bin/)
      if (existsSync(join(nodeModules, 'onnxruntime-node', 'bin'))) {
        renameSync(join(nodeModules, 'onnxruntime-node', 'bin'), finalBinDir);
      }

      // Step 5: Write version manifest
      const manifest: VersionManifest = {
        runtimeVersion: RUNTIME_VERSION,
        onnxruntimeNodeVersion: ONNXRUNTIME_NODE_VERSION,
        onnxruntimeCommonVersion: ONNXRUNTIME_COMMON_VERSION,
        transformersVersion: TRANSFORMERS_VERSION,
        platform: os,
        arch: cpu,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(tmpDir, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');

      // Clean up node_modules (no longer needed after bundling)
      rmSync(nodeModules, { recursive: true, force: true });

      // Step 6: Atomic swap — remove old install and rename temp to final
      // Preserve model-cache/ if it exists from a previous install
      const modelCacheDir = join(this.baseDir, 'model-cache');
      const hadModelCache = existsSync(modelCacheDir);
      let tmpModelCache: string | null = null;
      if (hadModelCache) {
        tmpModelCache = join(this.baseDir, `.model-cache-preserve-${Date.now()}`);
        renameSync(modelCacheDir, tmpModelCache);
      }

      // Remove old install (preserving the lock file and temp dirs)
      for (const entry of readdirSync(this.baseDir)) {
        if (entry.startsWith('.') || entry === tmpDir.split('/').pop()) continue;
        rmSync(join(this.baseDir, entry), { recursive: true, force: true });
      }

      // Move new files into place
      for (const entry of readdirSync(tmpDir)) {
        renameSync(join(tmpDir, entry), join(this.baseDir, entry));
      }

      // Restore model cache
      if (tmpModelCache && existsSync(tmpModelCache)) {
        renameSync(tmpModelCache, modelCacheDir);
      }

      log.info({ runtimeVersion: RUNTIME_VERSION }, 'Embedding runtime installed successfully');
    } catch (err) {
      log.error({ err }, 'Failed to install embedding runtime');
      throw err;
    } finally {
      // Clean up temp directory
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private readManifest(): VersionManifest | null {
    const manifestPath = join(this.baseDir, 'version.json');
    if (!existsSync(manifestPath)) return null;
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}

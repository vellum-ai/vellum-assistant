import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { getLogger } from '../util/logger.js';
import { getDataDir } from '../util/platform.js';

const log = getLogger('qdrant-manager');

const READYZ_POLL_INTERVAL_MS = 200;
const READYZ_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export interface QdrantManagerConfig {
  url: string;
  storagePath?: string;
}

/**
 * Manages the Qdrant sidecar process lifecycle.
 *
 * Desktop: spawns ~/.vellum/bin/qdrant as a child process.
 * K8s / external: connects to an existing Qdrant at the configured URL.
 *
 * Detection logic:
 * - If QDRANT_URL env var is set → external mode (don't spawn)
 * - If qdrant binary exists at ~/.vellum/bin/qdrant → local spawn mode
 * - Otherwise → external mode (assume sidecar or remote)
 */
export class QdrantManager {
  private process: Subprocess | null = null;
  private readonly url: string;
  private readonly host: string;
  private readonly port: number;
  private readonly storagePath: string;
  private readonly pidPath: string;
  private readonly isExternal: boolean;

  constructor(config: QdrantManagerConfig) {
    this.url = config.url;
    const parsed = new URL(config.url);
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port || '6333', 10);
    this.storagePath = config.storagePath ?? join(getDataDir(), 'data', 'qdrant');
    this.pidPath = join(getDataDir(), 'qdrant.pid');

    // External mode if QDRANT_URL is explicitly set or no local binary exists
    const hasEnvUrl = Boolean(process.env.QDRANT_URL?.trim());
    const localBinaryPath = this.getBinaryPath();
    this.isExternal = hasEnvUrl || !existsSync(localBinaryPath);
  }

  async start(): Promise<void> {
    if (this.isExternal) {
      log.info({ url: this.url }, 'Qdrant running in external mode, verifying connectivity');
      await this.waitForReady();
      return;
    }

    // Check for stale process
    this.cleanupStaleProcess();

    const binaryPath = this.getBinaryPath();
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Qdrant binary not found at ${binaryPath}. ` +
        'Install it or set QDRANT_URL to use an external Qdrant instance.',
      );
    }

    log.info({ binaryPath, storagePath: this.storagePath, port: this.port }, 'Starting Qdrant');

    this.process = Bun.spawn({
      cmd: [binaryPath],
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: this.host,
        QDRANT__SERVICE__HTTP_PORT: String(this.port),
        QDRANT__SERVICE__GRPC_PORT: '0', // disable gRPC
        QDRANT__TELEMETRY_DISABLED: 'true',
        QDRANT__STORAGE__STORAGE_PATH: this.storagePath,
        QDRANT__LOG_LEVEL: 'WARN',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    if (this.process.pid) {
      this.writePid(this.process.pid);
    }

    try {
      await this.waitForReady();
      log.info({ pid: this.process.pid, port: this.port }, 'Qdrant is ready');
    } catch (err) {
      // If startup fails, clean up
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.cleanupPid();
      return;
    }

    log.info('Stopping Qdrant');
    this.process.kill('SIGTERM');

    // Wait for graceful shutdown
    const graceful = await Promise.race([
      this.process.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
    ]);

    if (!graceful) {
      log.warn('Qdrant did not exit gracefully, sending SIGKILL');
      this.process.kill('SIGKILL');
      await this.process.exited;
    }

    this.process = null;
    this.cleanupPid();
    log.info('Qdrant stopped');
  }

  getUrl(): string {
    return this.url;
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < READYZ_TIMEOUT_MS) {
      try {
        const res = await fetch(`${this.url}/readyz`);
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await Bun.sleep(READYZ_POLL_INTERVAL_MS);
    }
    throw new Error(`Qdrant did not become ready within ${READYZ_TIMEOUT_MS}ms at ${this.url}`);
  }

  private getBinaryPath(): string {
    return join(getDataDir(), 'bin', 'qdrant');
  }

  private cleanupStaleProcess(): void {
    const pid = this.readPid();
    if (pid === null) return;

    try {
      process.kill(pid, 0); // Check if process exists
      // Process is still running — kill it
      log.warn({ pid }, 'Found stale Qdrant process, killing it');
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process doesn't exist, just clean up PID file
    }
    this.cleanupPid();
  }

  private readPid(): number | null {
    if (!existsSync(this.pidPath)) return null;
    try {
      const pid = parseInt(readFileSync(this.pidPath, 'utf-8').trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private writePid(pid: number): void {
    writeFileSync(this.pidPath, String(pid));
  }

  private cleanupPid(): void {
    if (existsSync(this.pidPath)) {
      try {
        unlinkSync(this.pidPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

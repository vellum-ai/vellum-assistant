import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

import type { Subprocess } from "bun";

import { getQdrantReadyzTimeoutMs, getQdrantUrlEnv } from "../config/env.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("qdrant-manager");

const QDRANT_VERSION = "1.13.2";
const READYZ_POLL_INTERVAL_MS = 200;
const READYZ_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export interface QdrantManagerConfig {
  url: string;
  storagePath?: string;
  /** Override readyz poll interval (ms). Default: 200 */
  readyzPollIntervalMs?: number;
  /** Override readyz timeout (ms). Default: 30 000 */
  readyzTimeoutMs?: number;
  /** Override SIGTERM→SIGKILL grace period (ms). Default: 5 000 */
  shutdownGraceMs?: number;
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
  private stderrBuffer = "";
  private stderrDrained: Promise<void> = Promise.resolve();
  private readonly url: string;
  private readonly host: string;
  private readonly port: number;
  private readonly storagePath: string;
  private readonly pidPath: string;
  private readonly isExternal: boolean;
  private readonly readyzPollIntervalMs: number;
  private readonly readyzTimeoutMs: number;
  private readonly shutdownGraceMs: number;

  constructor(config: QdrantManagerConfig) {
    this.url = config.url;
    const parsed = new URL(config.url);
    this.host = parsed.hostname;
    this.port = parseInt(parsed.port || "6333", 10);
    this.storagePath = config.storagePath ?? join(getDataDir(), "qdrant");
    this.pidPath = join(getDataDir(), "qdrant", "qdrant.pid");

    this.readyzPollIntervalMs =
      config.readyzPollIntervalMs ?? READYZ_POLL_INTERVAL_MS;
    this.readyzTimeoutMs =
      config.readyzTimeoutMs ?? getQdrantReadyzTimeoutMs() ?? READYZ_TIMEOUT_MS;
    this.shutdownGraceMs = config.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

    // External mode only if QDRANT_URL is explicitly set
    this.isExternal = Boolean(getQdrantUrlEnv());
  }

  async start(): Promise<void> {
    if (this.isExternal) {
      log.info(
        { url: this.url },
        "Qdrant running in external mode, verifying connectivity",
      );
      await this.waitForReady();
      return;
    }

    // Check for stale process
    this.cleanupStaleProcess();

    const binaryPath = this.getBinaryPath();
    if (!existsSync(binaryPath)) {
      await this.installBinary(binaryPath);
    }

    log.info(
      { binaryPath, storagePath: this.storagePath, port: this.port },
      "Starting Qdrant",
    );

    const proc = Bun.spawn({
      cmd: [binaryPath],
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: this.host,
        QDRANT__SERVICE__HTTP_PORT: String(this.port),
        QDRANT__SERVICE__GRPC_PORT: "0", // disable gRPC
        QDRANT__TELEMETRY_DISABLED: "true",
        QDRANT__STORAGE__STORAGE_PATH: this.storagePath,
        QDRANT__LOG_LEVEL: "WARN",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    this.process = proc;
    this.drainStderrFrom(proc.stderr);

    if (this.process.pid) {
      this.writePid(this.process.pid);
    }

    try {
      await this.waitForReady();
      log.info({ pid: this.process.pid, port: this.port }, "Qdrant is ready");
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

    log.info("Stopping Qdrant");
    this.process.kill("SIGTERM");

    // Wait for graceful shutdown
    const graceful = await Promise.race([
      this.process.exited.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), this.shutdownGraceMs),
      ),
    ]);

    if (!graceful) {
      log.warn("Qdrant did not exit gracefully, sending SIGKILL");
      this.process.kill("SIGKILL");
      await this.process.exited;
    }

    this.process = null;
    this.stderrBuffer = "";
    this.cleanupPid();
    log.info("Qdrant stopped");
  }

  getUrl(): string {
    return this.url;
  }

  private async installBinary(binaryPath: string): Promise<void> {
    const os = platform();
    const cpu = arch();

    let target: string;
    if (os === "darwin" && cpu === "arm64") {
      target = "aarch64-apple-darwin";
    } else if (os === "darwin" && cpu === "x64") {
      target = "x86_64-apple-darwin";
    } else if (os === "linux" && cpu === "x64") {
      target = "x86_64-unknown-linux-musl";
    } else if (os === "linux" && cpu === "arm64") {
      target = "aarch64-unknown-linux-musl";
    } else {
      throw new Error(
        `Unsupported platform: ${os}/${cpu}. ` +
          "Set QDRANT_URL to use an external Qdrant instance.",
      );
    }

    const filename = `qdrant-${target}.tar.gz`;
    const baseUrl = `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}`;
    const url = `${baseUrl}/${filename}`;
    const checksumUrl = `${baseUrl}/${filename}.sha256`;

    log.info({ url, binaryPath }, "Downloading Qdrant binary");

    // Fetch the tarball and its SHA-256 checksum in parallel
    const [response, checksumResponse] = await Promise.all([
      fetch(url),
      fetch(checksumUrl),
    ]);

    if (!response.ok) {
      throw new Error(
        `Failed to download Qdrant: ${response.status} ${response.statusText} from ${url}`,
      );
    }

    const tarball = await response.arrayBuffer();

    // Verify SHA-256 integrity if the checksum file is available
    if (checksumResponse.ok) {
      const checksumText = (await checksumResponse.text()).trim();
      // Checksum files contain "<hex>  <filename>" or just "<hex>"
      const expectedHash = checksumText.split(/\s+/)[0].toLowerCase();
      const actualHash = createHash("sha256")
        .update(Buffer.from(tarball))
        .digest("hex");

      if (actualHash !== expectedHash) {
        throw new Error(
          `Qdrant binary checksum mismatch! ` +
            `expected=${expectedHash} actual=${actualHash} url=${url}`,
        );
      }
      log.info({ hash: actualHash }, "Qdrant binary checksum verified");
    } else {
      log.warn(
        { checksumUrl, status: checksumResponse.status },
        "Could not fetch Qdrant checksum — skipping integrity check",
      );
    }

    // Extract the qdrant binary from the tarball
    const binDir = dirname(binaryPath);
    mkdirSync(binDir, { recursive: true });

    // Write tarball to temp file, extract with tar
    const tmpTar = join(binDir, `qdrant-download-${Date.now()}.tar.gz`);
    writeFileSync(tmpTar, Buffer.from(tarball));

    try {
      const proc = Bun.spawn({
        cmd: ["tar", "xzf", tmpTar, "-C", binDir, "qdrant"],
        stdout: "ignore",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to extract Qdrant binary: ${stderr}`);
      }
    } finally {
      try {
        unlinkSync(tmpTar);
      } catch {
        /* ignore */
      }
    }

    chmodSync(binaryPath, 0o755);
    log.info(
      { binaryPath, version: QDRANT_VERSION },
      "Qdrant binary installed",
    );
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < this.readyzTimeoutMs) {
      // Fail fast if the managed process exited before becoming ready
      if (this.process != null && this.process.exitCode != null) {
        await this.stderrDrained;
        const stderr = this.stderrBuffer.trim();
        throw new Error(
          `Qdrant process exited with code ${this.process.exitCode} before becoming ready` +
            (stderr ? `\nstderr:\n${stderr}` : ""),
        );
      }
      try {
        const res = await fetch(`${this.url}/readyz`);
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await Bun.sleep(this.readyzPollIntervalMs);
    }
    const stderr = this.stderrBuffer.trim();
    throw new Error(
      `Qdrant did not become ready within ${this.readyzTimeoutMs}ms at ${this.url}` +
        (stderr ? `\nstderr:\n${stderr}` : ""),
    );
  }

  private drainStderrFrom(stream: ReadableStream<Uint8Array>): void {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    this.stderrDrained = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.stderrBuffer += decoder.decode(value, { stream: true });
          if (this.stderrBuffer.length > 4096) {
            this.stderrBuffer = this.stderrBuffer.slice(-4096);
          }
        }
      } catch {
        // Stream closed or error — expected during shutdown
      }
    })();
  }

  private getBinaryPath(): string {
    return join(getDataDir(), "qdrant", "bin", "qdrant");
  }

  private cleanupStaleProcess(): void {
    const pid = this.readPid();
    if (pid == null) return;

    try {
      process.kill(pid, 0); // Check if process exists
      // Process is still running — kill it
      log.warn({ pid }, "Found stale Qdrant process, killing it");
      process.kill(pid, "SIGTERM");
    } catch {
      // Process doesn't exist, just clean up PID file
    }
    this.cleanupPid();
  }

  private readPid(): number | null {
    if (!existsSync(this.pidPath)) return null;
    try {
      const pid = parseInt(readFileSync(this.pidPath, "utf-8").trim(), 10);
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

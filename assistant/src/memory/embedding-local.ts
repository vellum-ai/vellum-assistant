import {
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import {
  getEmbeddingModelsDir,
  getEmbedWorkerPidPath,
} from "../util/platform.js";
import { PromiseGuard } from "../util/promise-guard.js";
import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "./embedding-backend.js";
import { EmbeddingRuntimeManager } from "./embedding-runtime-manager.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

const log = getLogger("memory-embedding-local");

interface WorkerResponse {
  id?: number;
  type?: string;
  vectors?: number[][];
  error?: string;
}

/**
 * Detect model loading errors (corrupted cache, incompatible ONNX format, etc.)
 * that can be resolved by clearing the model cache and re-downloading.
 */
function isModelCorruptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("protobuf parsing") ||
    (msg.includes("load model") && msg.includes("failed")) ||
    msg.includes("invalid model") ||
    msg.includes("corrupt")
  );
}

/** Remove the cached model files so they are re-downloaded on next attempt. */
function clearModelCache(): void {
  const embeddingModelsDir = getEmbeddingModelsDir();
  const modelCacheDir = join(embeddingModelsDir, "model-cache");
  if (existsSync(modelCacheDir)) {
    log.info({ modelCacheDir }, "Removing corrupted model cache");
    try {
      rmSync(modelCacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ err, modelCacheDir }, "Failed to remove model cache");
    }
  }
}

/**
 * Local embedding backend using @huggingface/transformers (ONNX Runtime).
 * Runs BAAI/bge-small-en-v1.5 locally — no API calls, no network required.
 *
 * Embeddings run in a **separate bun process** because compiled Bun binaries
 * cannot resolve bare specifier imports in dynamically loaded files. The embed
 * worker communicates via JSON-lines over stdin/stdout.
 *
 * The embedding runtime (onnxruntime-node + transformers + bun) is downloaded
 * post-hatch by EmbeddingRuntimeManager.
 *
 * Produces 384-dimensional embeddings.
 */
export class LocalEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "local" as const;
  readonly model: string;

  // Subprocess — typed loosely to avoid coupling to Bun's Subprocess generics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private workerProc: any = null;
  private stdoutBuffer = "";
  private requestCounter = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (response: WorkerResponse) => void;
    }
  >();
  private stdoutReaderActive = false;
  private activeEmbeds = 0;
  private disposeRequested = false;

  private readonly initGuard = new PromiseGuard<void>();

  constructor(model: string) {
    this.model = model;
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (this.disposeRequested) {
      throw new Error("Local embedding backend is shutting down");
    }
    if (inputs.length === 0) return [];

    const texts = inputs.map((i) => {
      const n = normalizeEmbeddingInput(i);
      if (n.type !== "text") {
        throw new Error("Local embedding backend only supports text inputs");
      }
      return n.text;
    });
    if (options?.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");

    this.activeEmbeds++;
    try {
      await this.ensureInitialized();

      const results: number[][] = [];
      const batchSize = 32;
      for (let i = 0; i < texts.length; i += batchSize) {
        if (options?.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        const batch = texts.slice(i, i + batchSize);
        const response = await this.sendRequest(batch);
        if (response.error) {
          throw new Error(`Embedding worker error: ${response.error}`);
        }
        if (!response.vectors) {
          throw new Error("Embedding worker returned no vectors");
        }
        results.push(...response.vectors);
      }
      return results;
    } finally {
      this.activeEmbeds--;
      this.disposeIfIdle();
    }
  }

  private sendRequest(texts: string[]): Promise<WorkerResponse> {
    const id = ++this.requestCounter;
    return new Promise((resolve) => {
      if (!this.workerProc) {
        resolve({ id, error: "Worker not initialized" });
        return;
      }
      this.pendingRequests.set(id, { resolve });
      this.workerProc.stdin.write(JSON.stringify({ id, texts }) + "\n");
      try {
        this.workerProc.stdin.flush();
      } catch {
        // Worker may have exited — pending request will be resolved by stdout reader cleanup
      }
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.workerProc) return;
    await this.initGuard.run(() => this.initialize());
  }

  dispose(): void {
    this.disposeRequested = true;
    this.disposeIfIdle();
  }

  private async initialize(): Promise<void> {
    log.info({ model: this.model }, "Initializing local embedding backend");

    const runtimeManager = new EmbeddingRuntimeManager();

    // Wait for download if in progress
    if (!runtimeManager.isReady()) {
      log.info("Embedding runtime not yet available, waiting for download...");
      await runtimeManager.ensureInstalled();
    }

    const bunPath = runtimeManager.getBunPath();
    const workerPath = runtimeManager.getWorkerPath();

    if (!bunPath) {
      throw new Error(
        "Local embedding backend unavailable: no bun binary found",
      );
    }
    if (!existsSync(workerPath)) {
      throw new Error(
        `Local embedding backend unavailable: worker script not found at ${workerPath}`,
      );
    }

    try {
      await this.startWorker(bunPath, workerPath);
    } catch (err) {
      // If the model cache is corrupted (e.g. protobuf parsing failure from an
      // incompatible or partially downloaded ONNX file), clear the cache and
      // retry once — the worker will re-download the model on the next attempt.
      if (isModelCorruptionError(err)) {
        log.warn(
          { err, model: this.model },
          "Model cache appears corrupted, clearing and retrying",
        );
        clearModelCache();
        await this.startWorker(bunPath, workerPath);
      } else {
        throw err;
      }
    }
  }

  private async startWorker(
    bunPath: string,
    workerPath: string,
  ): Promise<void> {
    const embeddingModelsDir = getEmbeddingModelsDir();
    const modelCacheDir = `${embeddingModelsDir}/model-cache`;

    // Singleton guard: an orphaned embed worker from a previous daemon
    // (e.g. one that crashed without cleanup) may still be running and
    // holding the workspace's PID file. Detect and reclaim it before
    // spawning so we never leave duplicate workers eating CPU/memory.
    this.reclaimStaleWorker();

    log.info(
      { bunPath, workerPath, model: this.model },
      "Spawning embedding worker process",
    );

    const proc = Bun.spawn({
      cmd: [bunPath, "--smol", workerPath, this.model, modelCacheDir],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: embeddingModelsDir,
    });

    // Type-compatible assignment
    this.workerProc = proc;

    // Start reading stdout for responses (needed for waitForReady)
    this.startStdoutReader();

    try {
      // Wait for the worker to signal it's ready (model loaded)
      await this.waitForReady();
    } catch (err) {
      // Worker failed to start — kill it to avoid deadlock, then collect stderr
      this.workerProc = null;
      this.stdoutReaderActive = false;
      try {
        proc.kill();
      } catch {
        /* may already be dead */
      }
      const exitCode = await proc.exited.catch(() => undefined);
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      if (stderr.trim()) {
        log.warn(
          { stderr: stderr.trim(), exitCode, bunPath },
          "Embedding worker stderr",
        );
      }
      throw new Error(
        `Embedding worker exited (code ${exitCode ?? "unknown"}): ${
          stderr.trim() || (err instanceof Error ? err.message : String(err))
        }`,
      );
    }

    // Worker is running — drain stderr in background for ongoing logging
    this.drainStderr(proc.stderr);

    // Write PID file so `vellum ps` can see the embed worker
    this.writePidFile(proc.pid);

    log.info(
      { pid: proc.pid, model: this.model },
      "Embedding worker process started",
    );

    this.disposeIfIdle();
  }

  private drainStderr(stderr: ReadableStream<Uint8Array>): void {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trim();
          if (text)
            log.debug({ workerStderr: text }, "Embedding worker stderr");
        }
      } catch {
        // Reader cancelled or stream errored — expected on shutdown
      }
    })();
  }

  private startStdoutReader(): void {
    if (this.stdoutReaderActive || !this.workerProc) return;
    this.stdoutReaderActive = true;

    // Capture reference to detect if a new worker was spawned during cleanup
    const proc = this.workerProc;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.stdoutBuffer += decoder.decode(value, { stream: true });
          this.processStdoutBuffer();
        }
      } catch {
        // Reader cancelled or stream errored
      }

      // Only clean up if this reader's proc is still the active one.
      // A new worker may have been spawned during the async cleanup window.
      if (this.workerProc === proc) {
        // Worker exited — reject all pending requests and clean up
        for (const [, pending] of this.pendingRequests) {
          pending.resolve({
            error: "Embedding worker process exited unexpectedly",
          });
        }
        this.pendingRequests.clear();
        this.workerProc = null;
        this.stdoutReaderActive = false;
        this.removePidFile();
        this.stdoutBuffer = "";
        // Allow re-initialization on next embed() call
        this.initGuard.reset();
      }
    })();
  }

  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  private processStdoutBuffer(): void {
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg: WorkerResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Skip malformed lines
      }

      // Handle ready/error signals during initialization
      if (msg.type === "ready") {
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        continue;
      }
      if (msg.type === "error" && this.readyReject) {
        this.readyReject(
          new Error(msg.error ?? "Worker initialization failed"),
        );
        this.readyResolve = null;
        this.readyReject = null;
        continue;
      }

      // Handle embed responses
      if (msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.resolve(msg);
          this.disposeIfIdle();
        }
      }
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      // Timeout after 2 minutes (first model download can be slow)
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(
          new Error("Embedding worker timed out waiting for model to load"),
        );
      }, 120_000);

      // Clear timeout when resolved
      const originalResolve = resolve;
      this.readyResolve = () => {
        clearTimeout(timeout);
        originalResolve();
      };
      const originalReject = reject;
      this.readyReject = (err: Error) => {
        clearTimeout(timeout);
        originalReject(err);
      };

      // Also handle early worker exit
      this.workerProc?.exited.then(() => {
        if (this.readyResolve) {
          clearTimeout(timeout);
          this.readyResolve = null;
          this.readyReject = null;
          reject(
            new Error("Embedding worker process exited before becoming ready"),
          );
        }
      });
    });
  }

  private static readonly PID_FILENAME = "embed-worker.pid";

  /** PID files are process-local state — store in /tmp when containerized to keep shared volumes clean. */
  private getPidFilePath(): string {
    if (getIsContainerized()) {
      return join("/tmp", LocalEmbeddingBackend.PID_FILENAME);
    }
    return getEmbedWorkerPidPath();
  }

  private writePidFile(pid: number): void {
    try {
      writeFileSync(this.getPidFilePath(), String(pid));
    } catch {
      // Best-effort — doesn't affect functionality
    }
  }

  private removePidFile(): void {
    try {
      unlinkSync(this.getPidFilePath());
    } catch {
      // Best-effort
    }
  }

  /** Read the PID from the on-disk PID file, or null if missing/invalid. */
  private readPidFile(): number | null {
    const path = this.getPidFilePath();
    if (!existsSync(path)) return null;
    try {
      const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Verify a PID looks like one of our embed workers before sending signals
   * to it — defends against PID-reuse killing an unrelated process if the
   * original worker exited and the OS recycled the PID.
   *
   * The generated worker script sets `process.title = 'embed-worker'` and is
   * always invoked via the `embed-worker.mjs` path under
   * `~/.vellum/workspace/embedding-models/`, so either marker is conclusive.
   */
  private isLikelyEmbedWorker(pid: number): boolean {
    try {
      const result = Bun.spawnSync({
        cmd: ["ps", "-p", String(pid), "-o", "command="],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode !== 0) return false;
      const cmd = new TextDecoder().decode(result.stdout).trim();
      if (!cmd) return false;
      return cmd.includes("embed-worker");
    } catch {
      return false;
    }
  }

  /**
   * If a previous embed worker is still running for this workspace (orphaned
   * by a crashed daemon, for example), terminate it before spawning a new one
   * so we never end up with duplicate workers competing for the same workspace.
   *
   * Stale PID files (process no longer exists) are silently cleaned up.
   * PIDs that have been recycled to unrelated processes are left untouched.
   */
  private reclaimStaleWorker(): void {
    const pid = this.readPidFile();
    if (pid == null) return;

    // Never signal ourselves — should not happen since the worker is a child
    // process, but guard against logic bugs that would deadlock the daemon.
    if (pid === process.pid) {
      this.removePidFile();
      return;
    }

    let isAlive = false;
    try {
      // Signal 0 just probes for liveness without delivering a signal.
      process.kill(pid, 0);
      isAlive = true;
    } catch {
      // ESRCH — no such process. PID file is stale.
    }

    if (!isAlive) {
      log.info(
        { pid, model: this.model },
        "Removing stale embed worker PID file (process no longer exists)",
      );
      this.removePidFile();
      return;
    }

    if (!this.isLikelyEmbedWorker(pid)) {
      // PID points to something that isn't ours (likely PID reuse after a
      // prior worker exited). Don't kill an unrelated process — just drop
      // the stale file and let the new worker take over the slot.
      log.warn(
        { pid, model: this.model },
        "PID file points to a non-embed-worker process; clearing without killing",
      );
      this.removePidFile();
      return;
    }

    log.warn(
      { pid, model: this.model },
      "Found orphaned embed worker from a previous daemon, terminating it",
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Race: it exited between the liveness check and the kill — fine.
    }
    this.removePidFile();
  }

  private disposeIfIdle(): void {
    if (!this.disposeRequested) return;
    if (this.activeEmbeds > 0) return;
    if (this.pendingRequests.size > 0) return;
    if (this.readyResolve || this.readyReject) return;

    const proc = this.workerProc;
    this.workerProc = null;
    this.stdoutReaderActive = false;
    this.stdoutBuffer = "";
    this.initGuard.reset();
    this.removePidFile();

    if (!proc) return;

    try {
      proc.kill();
    } catch {
      // Worker may already be exiting
    }
  }
}

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../../config/env-registry.js";
import { getLogger } from "../../util/logger.js";
import {
  getEmbeddingModelsDir,
  getEmbedWorkerPidPath,
} from "../../util/platform.js";
import { PromiseGuard } from "../../util/promise-guard.js";
import { workerMemoryEnv } from "../../util/worker-memory.js";
import { EmbeddingRuntimeManager } from "./embedding-runtime-manager.js";
import {
  type EmbeddingBackend,
  type EmbeddingInput,
  type EmbeddingRequestOptions,
  normalizeEmbeddingInput,
} from "./embedding-types.js";

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
  if (!(err instanceof Error)) {
    return false;
  }
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

/** Whether a PID names a live process. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes for liveness without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface WorkerProcess {
  pid: number;
  ppid: number;
}

/**
 * What this process may do with an embed worker it found in the process table.
 *
 * - `reclaim` — parented to us: a worker we started and lost track of. Reaping
 *   it is what enforces one live worker per owning process.
 * - `orphan` — reparented to init, or its owner is gone. Nobody else will ever
 *   clean it up.
 * - `foreign` — owned by another live process. The memory-worker process runs
 *   its own backend against this same workspace and is entitled to its own
 *   worker; signalling it is what made the two replace each other in a loop.
 */
export type WorkerOwnership = "reclaim" | "orphan" | "foreign";

export function classifyWorkerOwnership(
  worker: WorkerProcess,
  selfPid: number,
  isOwnerAlive: (pid: number) => boolean,
): WorkerOwnership {
  if (worker.ppid === selfPid) {
    return "reclaim";
  }
  if (worker.ppid <= 1 || !isOwnerAlive(worker.ppid)) {
    return "orphan";
  }
  return "foreign";
}

/** Enumerate `(pid, ppid, rawCommand)` rows from Linux `/proc`. */
function listProcessRowsFromProc(): {
  pid: number;
  ppid: number;
  cmd: string;
}[] {
  const rows: { pid: number; ppid: number; cmd: string }[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    try {
      // `stat` field 4 is ppid, but `comm` (field 2) may contain spaces or
      // parens — parse from the last ')' so a weird comm cannot shift fields.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      if (Number.isInteger(ppid)) {
        rows.push({ pid, ppid, cmd });
      }
    } catch {
      // Process exited between readdir and read — skip.
    }
  }
  return rows;
}

/** Enumerate `(pid, ppid, rawCommand)` rows via `ps` (macOS / no `/proc`). */
function listProcessRowsFromPs(): { pid: number; ppid: number; cmd: string }[] {
  // `-ww` disables column-width truncation. Without it, macOS `ps` clips the
  // command field to the terminal width, which can cut off the workerPath
  // argument and hide a genuine match. Same flag is used by
  // daemon-control.ts:123 for exactly this reason.
  const result = Bun.spawnSync({
    cmd: ["ps", "-A", "-ww", "-o", "pid=,ppid=,command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    return [];
  }
  const rows: { pid: number; ppid: number; cmd: string }[] = [];
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].trim() });
    }
  }
  return rows;
}

/**
 * Live embed-worker processes for this workspace, as `(pid, ppid)` pairs.
 *
 * Ownership of an embed worker is recorded by the OS process tree, not by the
 * PID file: a worker's parent IS its owner. The process table is therefore the
 * authoritative answer to "whose worker is this", and unlike the PID file it
 * survives a crash and cannot be overwritten by a second owner. That matters
 * because the daemon and the memory-worker process legitimately run one worker
 * each against the same workspace.
 *
 * Matches on the absolute worker script path, which lives under THIS
 * workspace's embedding-models directory and is therefore unique per assistant
 * instance — a sibling instance's workers never match. Raw command lines are
 * read for matching only, never stored or logged: process arguments can carry
 * secrets (see the redaction note in `util/process-tree.ts`).
 */
export function listWorkerProcesses(workerPath: string): WorkerProcess[] {
  let rows: { pid: number; ppid: number; cmd: string }[];
  try {
    rows = listProcessRowsFromProc();
  } catch {
    rows = listProcessRowsFromPs();
  }
  return rows
    .filter((r) => r.cmd.includes(workerPath))
    .map((r) => ({ pid: r.pid, ppid: r.ppid }));
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
    if (inputs.length === 0) {
      return [];
    }

    const texts = inputs.map((i) => {
      const n = normalizeEmbeddingInput(i);
      if (n.type !== "text") {
        throw new Error("Local embedding backend only supports text inputs");
      }
      return n.text;
    });
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    this.activeEmbeds++;
    try {
      await this.ensureInitialized();

      const results: number[][] = [];
      const batchSize = 32;
      for (let i = 0; i < texts.length; i += batchSize) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
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
      const proc = this.workerProc;
      if (!proc) {
        resolve({ id, error: "Worker not initialized" });
        return;
      }
      this.pendingRequests.set(id, { resolve });

      // Writing to a worker that has already exited raises EPIPE. That must
      // surface as an ordinary embed failure the caller can fall back from —
      // an escaping EPIPE reaches the daemon's `unhandledRejection` handler,
      // which tears down the whole process (JARVIS-1125). `flush()` may also
      // report the broken pipe asynchronously, so its promise is caught too.
      try {
        proc.stdin.write(JSON.stringify({ id, texts }) + "\n");
        const flushed: unknown = proc.stdin.flush();
        if (flushed instanceof Promise) {
          flushed.catch((err: unknown) => {
            this.failPendingRequest(id, err);
          });
        }
      } catch (err) {
        this.failPendingRequest(id, err);
      }
    });
  }

  /**
   * Resolve one in-flight request with an error. Resolving (rather than
   * rejecting) keeps the failure on the normal `embed()` path, where it becomes
   * a thrown `Error` the backend chain can fall back from.
   */
  private failPendingRequest(id: number, err: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, model: this.model }, "Embedding worker pipe write failed");
    pending.resolve({ id, error: `worker pipe write failed: ${message}` });
    this.disposeIfIdle();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.workerProc) {
      return;
    }
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

    // Singleton guard: a worker this process already owns (or one orphaned by
    // a crashed owner) may still be running. Reclaim it before spawning so we
    // never leave duplicate workers eating CPU/memory.
    this.reclaimOwnedWorkers(workerPath);

    log.info(
      { bunPath, workerPath, model: this.model },
      "Spawning embedding worker process",
    );

    const proc = Bun.spawn({
      cmd: [bunPath, "--smol", workerPath, this.model, modelCacheDir],
      env: workerMemoryEnv(),
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
          if (done) {
            break;
          }
          const text = decoder.decode(value, { stream: true }).trim();
          if (text) {
            log.debug({ workerStderr: text }, "Embedding worker stderr");
          }
        }
      } catch {
        // Reader cancelled or stream errored — expected on shutdown
      }
    })();
  }

  private startStdoutReader(): void {
    if (this.stdoutReaderActive || !this.workerProc) {
      return;
    }
    this.stdoutReaderActive = true;

    // Capture reference to detect if a new worker was spawned during cleanup
    const proc = this.workerProc;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          this.stdoutBuffer += decoder.decode(value, { stream: true });
          this.processStdoutBuffer();
        }
      } catch {
        // Reader cancelled or stream errored
      }

      // Only clean up if this reader's proc is still the active one.
      // A new worker may have been spawned during the async cleanup window.
      if (this.workerProc !== proc) {
        return;
      }

      // The stream ending does NOT prove the child exited — a read error ends
      // this loop just the same. Releasing ownership of a still-running child
      // strands it: nothing holds its handle any more and, once its PID file
      // entry is gone, no later reclaim can find it, so it lives until reboot
      // holding ~570 MB (JARVIS-1125). Terminate and wait for the OS to confirm
      // before forgetting it.
      await this.terminateWorker(proc);

      // Re-check: a new worker may have been spawned while we awaited exit.
      if (this.workerProc !== proc) {
        return;
      }

      for (const [, pending] of this.pendingRequests) {
        pending.resolve({
          error: "Embedding worker process exited unexpectedly",
        });
      }
      this.pendingRequests.clear();
      this.workerProc = null;
      this.stdoutReaderActive = false;
      this.releasePidFile(proc.pid);
      this.stdoutBuffer = "";
      // Allow re-initialization on next embed() call
      this.initGuard.reset();
    })();
  }

  /**
   * Terminate a worker and wait for the OS to confirm it is gone.
   *
   * Every path that gives up ownership of a worker goes through here, so the
   * invariant "we never forget a child we have not confirmed dead" holds even
   * when the trigger was a stream error rather than an exit.
   */
  private async terminateWorker(proc: {
    kill: () => void;
    exited: Promise<unknown>;
  }): Promise<void> {
    try {
      proc.kill();
    } catch {
      // Already exiting or already reaped.
    }
    try {
      await proc.exited;
    } catch {
      // Bun resolves `exited` on normal termination; ignore probe failures.
    }
  }

  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  private processStdoutBuffer(): void {
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line.trim()) {
        continue;
      }

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

      // Also handle early worker exit. The `catch` matters: an unhandled
      // rejection here reaches the daemon's fatal-error handler and takes the
      // process down, which is the same failure shape as the EPIPE in
      // `sendRequest` (JARVIS-1125).
      this.workerProc?.exited
        .then(() => {
          if (this.readyResolve) {
            clearTimeout(timeout);
            this.readyResolve = null;
            this.readyReject = null;
            reject(
              new Error(
                "Embedding worker process exited before becoming ready",
              ),
            );
          }
        })
        .catch(() => {
          // Exit status unavailable — the ready timeout is the backstop.
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

  /**
   * Drop the PID file, but only while it still names `ownedPid`.
   *
   * The file is a single workspace-scoped slot shared by every backend instance
   * and by the memory-worker process, so an unconditional unlink here deletes
   * whichever worker happens to be published — including a live one belonging
   * to somebody else. Compare-and-delete keeps a teardown from unpublishing a
   * worker it does not own (JARVIS-1125).
   */
  private releasePidFile(ownedPid: number): void {
    if (this.readPidFile() !== ownedPid) {
      return;
    }
    try {
      unlinkSync(this.getPidFilePath());
    } catch {
      // Best-effort
    }
  }

  /** Read the PID from the on-disk PID file, or null if missing/invalid. */
  private readPidFile(): number | null {
    const path = this.getPidFilePath();
    if (!existsSync(path)) {
      return null;
    }
    try {
      const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Terminate every embed worker this process is responsible for, so spawning
   * a replacement cannot leave a duplicate behind.
   *
   * Responsibility is read off the process tree rather than the PID file. A
   * worker's parent is its owner, which makes ownership survive a crash and
   * immune to a second owner overwriting the shared PID file — the two failure
   * modes behind JARVIS-1125. See {@link classifyWorkerOwnership} for the
   * per-worker decision; this also recovers workers stranded by earlier daemon
   * generations, not just the single entry a PID file can hold.
   */
  private reclaimOwnedWorkers(workerPath: string): void {
    for (const worker of listWorkerProcesses(workerPath)) {
      // Never signal ourselves — should not happen since the worker is a child
      // process, but guard against logic bugs that would deadlock the daemon.
      if (worker.pid === process.pid) {
        continue;
      }

      const ownership = classifyWorkerOwnership(
        worker,
        process.pid,
        isProcessAlive,
      );
      if (ownership === "foreign") {
        continue;
      }

      log.warn(
        { pid: worker.pid, ownerPid: worker.ppid, model: this.model },
        ownership === "reclaim"
          ? "Reclaiming an embed worker this process had lost track of"
          : "Terminating an orphaned embed worker from a previous owner",
      );
      try {
        process.kill(worker.pid, "SIGTERM");
      } catch {
        // Race: it exited between enumeration and the kill — fine.
      }
      this.releasePidFile(worker.pid);
    }

    // A PID file naming a process that is gone (or was never ours) is stale;
    // drop it so the worker we are about to spawn can publish cleanly.
    const published = this.readPidFile();
    if (published != null && !isProcessAlive(published)) {
      this.releasePidFile(published);
    }
  }

  private disposeIfIdle(): void {
    if (!this.disposeRequested) {
      return;
    }
    if (this.activeEmbeds > 0) {
      return;
    }
    if (this.pendingRequests.size > 0) {
      return;
    }
    if (this.readyResolve || this.readyReject) {
      return;
    }

    const proc = this.workerProc;
    this.workerProc = null;
    this.stdoutReaderActive = false;
    this.stdoutBuffer = "";
    this.initGuard.reset();

    // An instance whose worker already exited owns nothing. Unlinking the PID
    // file here would unpublish whichever worker is currently registered —
    // typically a live one belonging to another instance, which then becomes
    // invisible to every later reclaim. Only release what we actually hold.
    if (!proc) {
      return;
    }

    this.releasePidFile(proc.pid);
    void this.terminateWorker(proc);
  }

  /**
   * Terminate this backend's worker and wait for the child to exit.
   *
   * The deterministic counterpart to {@link dispose} for daemon shutdown: it
   * ignores the idle checks (the process is going away, so deferring until
   * in-flight embeds settle would just orphan the child) and resolves only once
   * the OS confirms the worker is gone.
   */
  async shutdown(): Promise<void> {
    this.disposeRequested = true;

    const proc = this.workerProc;
    this.workerProc = null;
    this.stdoutReaderActive = false;
    this.stdoutBuffer = "";
    this.initGuard.reset();

    for (const [, pending] of this.pendingRequests) {
      pending.resolve({ error: "Local embedding backend is shutting down" });
    }
    this.pendingRequests.clear();

    if (!proc) {
      return;
    }

    this.releasePidFile(proc.pid);
    await this.terminateWorker(proc);
  }
}

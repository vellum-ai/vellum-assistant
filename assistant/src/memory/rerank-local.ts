/** Local cross-encoder rerank backend — drives the rerank-worker subprocess. */
import { existsSync } from "node:fs";

import { getLogger } from "../util/logger.js";
import { getEmbeddingModelsDir } from "../util/platform.js";
import { PromiseGuard } from "../util/promise-guard.js";
import { EmbeddingRuntimeManager } from "./embedding-runtime-manager.js";

const log = getLogger("memory-rerank-local");

interface WorkerResponse {
  id?: number;
  type?: string;
  scores?: number[];
  error?: string;
}

export class LocalRerankBackend {
  readonly model: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private workerProc: any = null;
  private stdoutBuffer = "";
  private requestCounter = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (response: WorkerResponse) => void }
  >();
  private stdoutReaderActive = false;
  private activeRequests = 0;
  private disposeRequested = false;

  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  private readonly initGuard = new PromiseGuard<void>();

  constructor(model: string) {
    this.model = model;
  }

  /** Score `(query, passages[i])` pairs in one batched ONNX inference call. */
  async score(query: string, passages: string[]): Promise<number[]> {
    if (this.disposeRequested) {
      throw new Error("Local rerank backend is shutting down");
    }
    if (passages.length === 0) return [];

    this.activeRequests++;
    try {
      await this.ensureInitialized();
      const response = await this.sendRequest({ query, passages });
      if (response.error) {
        throw new Error(`Rerank worker error: ${response.error}`);
      }
      if (!response.scores) {
        throw new Error("Rerank worker returned no scores");
      }
      if (response.scores.length !== passages.length) {
        throw new Error(
          `Rerank worker returned ${response.scores.length} scores for ${passages.length} passages`,
        );
      }
      return response.scores;
    } finally {
      this.activeRequests--;
      this.disposeIfIdle();
    }
  }

  dispose(): void {
    this.disposeRequested = true;
    this.disposeIfIdle();
  }

  private sendRequest(payload: {
    query: string;
    passages: string[];
  }): Promise<WorkerResponse> {
    const id = ++this.requestCounter;
    return new Promise((resolve) => {
      if (!this.workerProc) {
        resolve({ error: "Worker not initialized" });
        return;
      }
      this.pendingRequests.set(id, { resolve });
      this.workerProc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      try {
        this.workerProc.stdin.flush();
      } catch {
        // Worker may have exited — stdout reader cleanup resolves pending requests.
      }
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.workerProc) return;
    await this.initGuard.run(() => this.initialize());
  }

  private async initialize(): Promise<void> {
    log.info({ model: this.model }, "Initializing local rerank backend");

    const runtimeManager = new EmbeddingRuntimeManager();
    if (!runtimeManager.isReady()) {
      log.info("Embedding runtime not yet available, waiting for download...");
      await runtimeManager.ensureInstalled();
    }

    const bunPath = runtimeManager.getBunPath();
    const workerPath = runtimeManager.getRerankWorkerPath();

    if (!bunPath) {
      throw new Error("Local rerank backend unavailable: no bun binary found");
    }
    if (!existsSync(workerPath)) {
      throw new Error(
        `Local rerank backend unavailable: worker script not found at ${workerPath}`,
      );
    }

    await this.startWorker(bunPath, workerPath);
  }

  private async startWorker(
    bunPath: string,
    workerPath: string,
  ): Promise<void> {
    const embeddingModelsDir = getEmbeddingModelsDir();
    const modelCacheDir = `${embeddingModelsDir}/model-cache`;

    log.info(
      { bunPath, workerPath, model: this.model },
      "Spawning rerank worker process",
    );

    const proc = Bun.spawn({
      cmd: [bunPath, "--smol", workerPath, this.model, modelCacheDir],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: embeddingModelsDir,
    });

    this.workerProc = proc;
    this.startStdoutReader();

    try {
      await this.waitForReady();
    } catch (err) {
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
        log.warn({ stderr: stderr.trim(), exitCode }, "Rerank worker stderr");
      }
      throw new Error(
        `Rerank worker exited (code ${exitCode ?? "unknown"}): ${
          stderr.trim() || (err instanceof Error ? err.message : String(err))
        }`,
      );
    }

    this.drainStderr(proc.stderr);
    log.info(
      { pid: proc.pid, model: this.model },
      "Rerank worker process started",
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
          if (text) log.debug({ workerStderr: text }, "Rerank worker stderr");
        }
      } catch {
        /* expected on shutdown */
      }
    })();
  }

  private startStdoutReader(): void {
    if (this.stdoutReaderActive || !this.workerProc) return;
    this.stdoutReaderActive = true;

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
        /* reader cancelled or stream errored */
      }

      if (this.workerProc === proc) {
        for (const pending of this.pendingRequests.values()) {
          pending.resolve({
            error: "Rerank worker process exited unexpectedly",
          });
        }
        this.pendingRequests.clear();
        this.workerProc = null;
        this.stdoutReaderActive = false;
        this.stdoutBuffer = "";
        this.initGuard.reset();
      }
    })();
  }

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
        continue;
      }

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
      // First-call timeout. Generous because the first run downloads the
      // ONNX weights (~280 MB to ~1 GB depending on model) before loading.
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(new Error("Rerank worker timed out waiting for model to load"));
      }, 120_000);

      this.readyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.workerProc?.exited.then(() => {
        if (this.readyResolve) {
          clearTimeout(timeout);
          this.readyResolve = null;
          this.readyReject = null;
          reject(
            new Error("Rerank worker process exited before becoming ready"),
          );
        }
      });
    });
  }

  private disposeIfIdle(): void {
    if (!this.disposeRequested) return;
    if (this.activeRequests > 0) return;
    if (this.pendingRequests.size > 0) return;
    if (this.readyResolve || this.readyReject) return;

    const proc = this.workerProc;
    this.workerProc = null;
    this.stdoutReaderActive = false;
    this.stdoutBuffer = "";
    this.initGuard.reset();

    if (!proc) return;

    try {
      proc.kill();
    } catch {
      /* may already be exiting */
    }
  }
}

// ── Module-level singleton management ─────────────────────────────────

let _backend: LocalRerankBackend | null = null;

export function getOrCreateRerankBackend(model: string): LocalRerankBackend {
  if (_backend?.model === model) return _backend;
  if (_backend) {
    try {
      _backend.dispose();
    } catch {
      /* best effort */
    }
  }
  _backend = new LocalRerankBackend(model);
  return _backend;
}

/** @internal Test-only: reset the cached backend. */
export function _resetRerankBackendForTests(): void {
  if (_backend) {
    try {
      _backend.dispose();
    } catch {
      /* best effort */
    }
  }
  _backend = null;
}

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findBun } from "../../util/bun-runtime.js";
import { getLogger } from "../../util/logger.js";
import { PromiseGuard } from "../../util/promise-guard.js";
import { GEMINI_WORKER_SCRIPT } from "./embedding-gemini-worker-script.js";
import type {
  EmbeddingBackend,
  EmbeddingInput,
  EmbeddingRequestOptions,
  EmbeddingTaskType,
  MultimodalEmbeddingInput,
} from "./embedding-types.js";
import { normalizeEmbeddingInput } from "./embedding-types.js";

const log = getLogger("memory-embedding-gemini");

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

interface WorkerResponse {
  id?: number;
  type?: string;
  values?: number[];
  error?: string;
}

export interface GeminiEmbeddingOptions {
  taskType?: EmbeddingTaskType;
  dimensions?: number;
  /** When set, routes requests through the managed proxy at this base URL. */
  managedBaseUrl?: string;
  /**
   * When true, runs HTTP calls in-process rather than spawning a worker
   * subprocess. Set in tests that mock globalThis.fetch.
   * @internal
   */
  bypassWorker?: boolean;
}

// Module-level flag so integration tests that cannot pass options through the
// embedding-backend registry can still force the in-process path.
let _moduleBypassWorker = false;

/** @internal - test use only */
export function _setBypassWorkerForTests(bypass: boolean): void {
  _moduleBypassWorker = bypass;
}

export class GeminiEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly taskType?: EmbeddingTaskType;
  private readonly dimensions?: number;
  private readonly managedBaseUrl?: string;
  private readonly bypassWorker: boolean;

  // Worker subprocess state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private workerProc: any = null;
  private stdoutBuffer = "";
  private requestCounter = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (r: WorkerResponse) => void }
  >();
  private stdoutReaderActive = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private disposeRequested = false;

  private readonly initGuard = new PromiseGuard<void>();

  constructor(apiKey: string, model: string, options?: GeminiEmbeddingOptions) {
    this.apiKey = apiKey;
    this.model = model;
    this.taskType = options?.taskType;
    this.dimensions = options?.dimensions;
    this.managedBaseUrl = options?.managedBaseUrl;
    this.bypassWorker = options?.bypassWorker ?? _moduleBypassWorker;
  }

  /** True when requests route through the managed platform proxy. */
  get managed(): boolean {
    return Boolean(this.managedBaseUrl);
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    if (this.bypassWorker) {
      return this.embedInProcess(inputs, options);
    }
    return this.embedViaWorker(inputs, options);
  }

  // In-process path (test-only).

  private async embedInProcess(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const input of inputs) {
      vectors.push(await this.embedSingle(input, options));
    }
    return vectors;
  }

  private async embedSingle(
    input: EmbeddingInput,
    options?: EmbeddingRequestOptions,
  ): Promise<number[]> {
    const normalized = normalizeEmbeddingInput(input);
    const parts = this.buildParts(normalized);

    const body: Record<string, unknown> = { content: { parts } };
    // Do NOT set `model` in the body. Gemini's embedContent API models `model`
    // as a protobuf oneof populated from the URL path (internally `_model`),
    // so adding it to the body triggers a 400: "oneof field '_model' is
    // already set. Cannot set 'model'".
    if (this.taskType) {
      body.taskType = this.taskType;
    }
    if (this.dimensions) {
      body.outputDimensionality = this.dimensions;
    }

    const url = this.managedBaseUrl
      ? `${this.managedBaseUrl}/v1beta/models/${encodeURIComponent(this.model)}:embedContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:embedContent?key=${encodeURIComponent(this.apiKey)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.managedBaseUrl) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `Gemini embeddings request failed (${response.status}): ${responseBody}`,
      );
    }
    const payload = (await response.json()) as GeminiEmbedResponse;
    const values = payload.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Gemini embeddings response missing vector values");
    }
    return values;
  }

  // Worker subprocess path (production).

  private async embedViaWorker(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    await this.ensureWorker();

    // Send all requests concurrently. The worker handles each fetch independently.
    const promises = inputs.map((input) => {
      const normalized = normalizeEmbeddingInput(input);
      const parts = this.buildParts(normalized);
      const id = ++this.requestCounter;
      const req: Record<string, unknown> = { id, parts };
      if (this.taskType) {
        req.taskType = this.taskType;
      }
      if (this.dimensions) {
        req.outputDimensionality = this.dimensions;
      }
      return this.sendWorkerRequest(id, req, options?.signal);
    });

    const responses = await Promise.all(promises);
    return responses.map((r, i) => {
      if (r.error) {
        throw new Error(`Gemini embedding worker error: ${r.error}`);
      }
      if (!r.values || r.values.length === 0) {
        throw new Error(
          `Gemini embeddings response missing vector values (input ${i})`,
        );
      }
      return r.values;
    });
  }

  private sendWorkerRequest(
    id: number,
    req: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      this.pendingRequests.set(id, { resolve });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (this.pendingRequests.delete(id)) {
              reject(new DOMException("Aborted", "AbortError"));
              // Propagate cancellation so the worker can abort the in-flight fetch.
              try {
                const proc = this.workerProc;
                if (proc) {
                  proc.stdin.write(JSON.stringify({ cancel: id }) + "\n");
                  proc.stdin.flush();
                }
              } catch {
                /* pipe may already be closed */
              }
            }
          },
          { once: true },
        );
      }

      const proc = this.workerProc;
      if (!proc) {
        this.pendingRequests.delete(id);
        reject(new Error("Gemini embedding worker not initialized"));
        return;
      }
      try {
        proc.stdin.write(JSON.stringify(req) + "\n");
        proc.stdin.flush();
      } catch (err) {
        this.pendingRequests.delete(id);
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ id, error: `worker pipe write failed: ${msg}` });
      }
    });
  }

  private async ensureWorker(): Promise<void> {
    if (this.disposeRequested) {
      throw new Error("Gemini embedding backend has been shut down");
    }
    if (this.workerProc) {
      return;
    }
    await this.initGuard.run(() => this.spawnWorker());
  }

  private async spawnWorker(): Promise<void> {
    if (this.workerProc || this.disposeRequested) {
      return;
    }

    const bunPath = findBun();
    if (!bunPath) {
      throw new Error(
        "Gemini embedding worker unavailable: no bun binary found",
      );
    }

    const workerPath = join(tmpdir(), `gemini-embed-worker-${process.pid}.mjs`);
    writeFileSync(workerPath, GEMINI_WORKER_SCRIPT);

    log.info(
      { bunPath, model: this.model, managed: this.managed },
      "Spawning Gemini embedding worker",
    );

    const env: Record<string, string> = {
      GEMINI_EMBED_API_KEY: this.apiKey,
      GEMINI_EMBED_MODEL: this.model,
    };
    if (this.managedBaseUrl) {
      env.GEMINI_EMBED_MANAGED_URL = this.managedBaseUrl;
    }

    const proc = Bun.spawn({
      cmd: [bunPath, workerPath],
      windowsHide: true,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.workerProc = proc;
    this.startStdoutReader();

    try {
      await this.waitForReady();
    } catch (err) {
      this.workerProc = null;
      this.stdoutReaderActive = false;
      this.stdoutBuffer = "";
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      throw err;
    }

    // If shutdown was called while this init was in flight, kill the proc we
    // just started and return. sweepOwnedWorkers() is the backstop if the
    // initGuard settled after shutdown already checked workerProc.
    if (this.disposeRequested) {
      this.terminateWorker(
        "Gemini embedding backend disposed during initialization",
      );
      return;
    }

    log.info(
      { pid: proc.pid, model: this.model },
      "Gemini embedding worker ready",
    );

    this.drainStderr(proc.stderr);
  }

  // Lifecycle hooks called by the embedding backend registry.

  /** Called on cache clear: kills the worker immediately, no wait. */
  dispose(): void {
    this.disposeRequested = true;
    this.terminateWorker("Gemini embedding worker disposed");
  }

  /** Called on daemon shutdown: kills the worker and waits for OS confirmation. */
  async shutdown(): Promise<void> {
    this.disposeRequested = true;
    await this.terminateWorkerAndWait("Gemini embedding worker shut down");
  }

  /**
   * Backstop for workers spawned after shutdown() already ran. Called by the
   * embedding backend registry after the shutdown budget expires.
   */
  async sweepOwnedWorkers(): Promise<void> {
    if (!this.disposeRequested || !this.workerProc) {
      return;
    }
    this.terminateWorker("Gemini embedding worker swept");
  }

  private terminateWorker(reason: string): void {
    const proc = this.workerProc;
    if (!proc) {
      return;
    }
    this.workerProc = null;
    this.stdoutBuffer = "";
    this.initGuard.reset();
    for (const [, pending] of this.pendingRequests) {
      pending.resolve({ error: reason });
    }
    this.pendingRequests.clear();
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  private async terminateWorkerAndWait(reason: string): Promise<void> {
    const proc = this.workerProc;
    if (!proc) {
      return;
    }
    this.workerProc = null;
    this.stdoutBuffer = "";
    this.initGuard.reset();
    for (const [, pending] of this.pendingRequests) {
      pending.resolve({ error: reason });
    }
    this.pendingRequests.clear();
    try {
      proc.kill("SIGTERM");
      const exitTimeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3_000);
      await proc.exited;
      clearTimeout(exitTimeout);
    } catch {
      /* already gone */
    }
  }

  private startStdoutReader(): void {
    if (this.stdoutReaderActive || !this.workerProc) {
      return;
    }
    this.stdoutReaderActive = true;
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
        /* stream closed or cancelled */
      }

      if (this.workerProc !== proc) {
        return;
      }

      // Worker exited unexpectedly: fail all in-flight requests.
      for (const [, pending] of this.pendingRequests) {
        pending.resolve({ error: "Gemini embedding worker process exited" });
      }
      this.pendingRequests.clear();
      this.workerProc = null;
      this.stdoutReaderActive = false;
      this.stdoutBuffer = "";
      this.initGuard.reset();
    })();
  }

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
          new Error(msg.error ?? "Gemini worker initialization failed"),
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
        }
      }
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(
          new Error(
            "Gemini embedding worker timed out waiting for ready signal",
          ),
        );
      }, 10_000);

      this.readyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.workerProc?.exited
        .then(() => {
          if (this.readyResolve) {
            clearTimeout(timeout);
            this.readyResolve = null;
            this.readyReject = null;
            reject(
              new Error(
                "Gemini embedding worker process exited before becoming ready",
              ),
            );
          }
        })
        .catch(() => {
          /* exit status unavailable, rely on timeout */
        });
    });
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
            log.debug({ workerStderr: text }, "Gemini embedding worker stderr");
          }
        }
      } catch {
        /* expected on shutdown */
      }
    })();
  }

  // Shared helper.

  private buildParts(input: MultimodalEmbeddingInput): unknown[] {
    if (input.type === "text") {
      return [{ text: input.text }];
    }
    // Image, audio, video: use inline_data with base64
    return [
      {
        inline_data: {
          mime_type: input.mimeType,
          data: input.data.toString("base64"),
        },
      },
    ];
  }
}

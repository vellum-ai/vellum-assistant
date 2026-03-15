import type { SwarmTaskNode, SwarmTaskResult } from "./types.js";
import type { SwarmWorkerBackend } from "./worker-backend.js";
import { roleToProfile } from "./worker-backend.js";
import { buildWorkerPrompt, parseWorkerOutput } from "./worker-prompts.js";

export type WorkerStatusKind = "queued" | "running" | "completed" | "failed";

export type WorkerStatusCallback = (
  taskId: string,
  status: WorkerStatusKind,
) => void;

export interface RunWorkerTaskOptions {
  task: SwarmTaskNode;
  /** Top-level objective context passed from the orchestrator. */
  upstreamContext?: string;
  /** Summaries from completed dependency tasks. */
  dependencyOutputs?: Array<{ taskId: string; summary: string }>;
  backend: SwarmWorkerBackend;
  workingDir: string;
  modelIntent?: string;
  timeoutMs: number;
  onStatus?: WorkerStatusCallback;
  signal?: AbortSignal;
}

function emitStatus(
  onStatus: WorkerStatusCallback | undefined,
  taskId: string,
  status: WorkerStatusKind,
): void {
  if (!onStatus) return;
  try {
    onStatus(taskId, status);
  } catch {
    // Observer failures must not abort worker execution.
  }
}

/**
 * Execute a single swarm worker task through the given backend.
 * Returns a normalized SwarmTaskResult regardless of success or failure.
 */
export async function runWorkerTask(
  opts: RunWorkerTaskOptions,
): Promise<SwarmTaskResult> {
  const { task, backend, workingDir, timeoutMs, onStatus, signal } = opts;

  if (signal?.aborted) {
    return {
      taskId: task.id,
      status: "failed",
      summary: "Cancelled",
      artifacts: [],
      issues: ["aborted"],
      nextSteps: [],
      rawOutput: "",
      durationMs: 0,
      retryCount: 0,
    };
  }

  emitStatus(onStatus, task.id, "queued");

  // Check backend availability
  if (!(await backend.isAvailable())) {
    emitStatus(onStatus, task.id, "failed");
    return {
      taskId: task.id,
      status: "failed",
      summary: `Backend "${backend.name}" is not available. Check API key and SDK configuration.`,
      artifacts: [],
      issues: [`Backend "${backend.name}" unavailable`],
      nextSteps: ["Configure the backend or use a different one"],
      rawOutput: "",
      durationMs: 0,
      retryCount: 0,
    };
  }

  emitStatus(onStatus, task.id, "running");

  const prompt = buildWorkerPrompt({
    role: task.role,
    objective: task.objective,
    upstreamContext: opts.upstreamContext,
    dependencyOutputs: opts.dependencyOutputs,
  });

  const profile = roleToProfile(task.role);

  try {
    const backendPromise = backend.runTask({
      prompt,
      profile,
      workingDir,
      modelIntent: opts.modelIntent,
      timeoutMs,
      signal,
    });

    // Enforce timeout via Promise.race
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Don't keep the process alive just for this timer
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

    const raceResult = await Promise.race([backendPromise, timeoutPromise]);

    if (raceResult === "timeout") {
      emitStatus(onStatus, task.id, "failed");
      return {
        taskId: task.id,
        status: "failed",
        summary: `Worker timed out after ${timeoutMs}ms`,
        artifacts: [],
        issues: ["timeout"],
        nextSteps: [],
        rawOutput: "",
        durationMs: timeoutMs,
        retryCount: 0,
      };
    }

    const result = raceResult;

    if (result.success) {
      const parsed = parseWorkerOutput(result.output);
      emitStatus(onStatus, task.id, "completed");
      return {
        taskId: task.id,
        status: "completed",
        ...parsed,
        rawOutput: result.output,
        durationMs: result.durationMs,
        retryCount: 0,
      };
    }

    // Backend returned a failure
    emitStatus(onStatus, task.id, "failed");
    return {
      taskId: task.id,
      status: "failed",
      summary:
        result.output || `Task failed: ${result.failureReason ?? "unknown"}`,
      artifacts: [],
      issues: [result.failureReason ?? "unknown_failure"],
      nextSteps: [],
      rawOutput: result.output,
      durationMs: result.durationMs,
      retryCount: 0,
    };
  } catch (err) {
    emitStatus(onStatus, task.id, "failed");
    const message = err instanceof Error ? err.message : String(err);
    return {
      taskId: task.id,
      status: "failed",
      summary: `Unexpected error: ${message}`,
      artifacts: [],
      issues: [message],
      nextSteps: [],
      rawOutput: "",
      durationMs: 0,
      retryCount: 0,
    };
  }
}

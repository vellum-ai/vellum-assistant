import type { ToolExecutionResult } from "../tools/types.js";

export interface BackgroundExecution {
  executionId: string;
  toolName: string;
  toolUseId: string;
  conversationId: string;
  startedAt: number;
  promise: Promise<ToolExecutionResult>;
  result?: ToolExecutionResult;
  status: "running" | "completed" | "cancelled";
  abortController?: AbortController;
}

export class BackgroundToolManager {
  private executions = new Map<string, BackgroundExecution>();

  register(exec: Omit<BackgroundExecution, "status" | "result">): void {
    const entry: BackgroundExecution = {
      ...exec,
      status: "running",
    };
    this.executions.set(exec.executionId, entry);

    // Attach completion handler — when the promise resolves, update status
    // and store the result. Guard against the entry being cancelled or
    // removed before the promise settles.
    exec.promise.then(
      (result) => {
        const current = this.executions.get(exec.executionId);
        if (current && current.status === "running") {
          current.status = "completed";
          current.result = result;
        }
      },
      (_err) => {
        // If the promise rejects (e.g. tool threw), treat as completed with
        // an error result so drainCompleted can pick it up.
        const current = this.executions.get(exec.executionId);
        if (current && current.status === "running") {
          current.status = "completed";
          current.result = {
            content: _err instanceof Error ? _err.message : String(_err),
            isError: true,
          };
        }
      },
    );
  }

  getStatus(executionId: string): {
    status: "running" | "completed" | "cancelled";
    elapsedMs: number;
    toolName: string;
    conversationId: string;
    result?: ToolExecutionResult;
  } | null {
    const entry = this.executions.get(executionId);
    if (!entry) return null;
    return {
      status: entry.status,
      elapsedMs: Date.now() - entry.startedAt,
      toolName: entry.toolName,
      conversationId: entry.conversationId,
      result: entry.result,
    };
  }

  async waitFor(
    executionId: string,
    timeoutMs: number,
  ): Promise<{ completed: boolean; result?: ToolExecutionResult }> {
    const entry = this.executions.get(executionId);
    if (!entry) return { completed: false };

    // Already done — return immediately
    if (entry.status === "completed") {
      return { completed: true, result: entry.result };
    }
    if (entry.status === "cancelled") {
      return { completed: false };
    }

    // Race the execution promise against a timeout
    return new Promise<{ completed: boolean; result?: ToolExecutionResult }>(
      (resolve) => {
        const timer = setTimeout(() => {
          resolve({ completed: false });
        }, timeoutMs);

        entry.promise
          .then((result) => {
            clearTimeout(timer);
            // Re-check the entry — it may have been cancelled while we waited
            const current = this.executions.get(executionId);
            if (current && current.status === "cancelled") {
              resolve({ completed: false });
            } else {
              resolve({ completed: true, result });
            }
          })
          .catch(() => {
            clearTimeout(timer);
            // Re-read the entry — the .then handler in register() may have
            // already populated the error result, or it may have been cancelled.
            const current = this.executions.get(executionId);
            if (current && current.status === "cancelled") {
              resolve({ completed: false });
            } else {
              resolve({
                completed: true,
                result: current?.result,
              });
            }
          });
      },
    );
  }

  cancel(executionId: string): { cancelled: boolean; message: string } {
    const entry = this.executions.get(executionId);
    if (!entry) {
      return {
        cancelled: false,
        message: `No execution found with ID ${executionId}`,
      };
    }
    if (entry.status !== "running") {
      return {
        cancelled: false,
        message: `Execution ${executionId} is already ${entry.status}`,
      };
    }

    entry.status = "cancelled";
    if (entry.abortController) {
      entry.abortController.abort();
    }
    return {
      cancelled: true,
      message: `Execution ${executionId} (${entry.toolName}) cancelled`,
    };
  }

  drainCompleted(conversationId: string): BackgroundExecution[] {
    const completed: BackgroundExecution[] = [];
    for (const [id, entry] of this.executions) {
      if (
        entry.conversationId === conversationId &&
        entry.status === "completed"
      ) {
        completed.push(entry);
        this.executions.delete(id);
      }
    }
    return completed;
  }

  getActiveCount(conversationId: string): number {
    let count = 0;
    for (const entry of this.executions.values()) {
      if (
        entry.conversationId === conversationId &&
        entry.status === "running"
      ) {
        count++;
      }
    }
    return count;
  }

  cleanup(conversationId: string): void {
    for (const [id, entry] of this.executions) {
      if (entry.conversationId === conversationId) {
        if (entry.status === "running" && entry.abortController) {
          entry.abortController.abort();
        }
        this.executions.delete(id);
      }
    }
  }
}

export const backgroundToolManager = new BackgroundToolManager();

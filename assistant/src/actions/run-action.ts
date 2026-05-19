import { v4 as uuid } from "uuid";

import { recordToolInvocation } from "../memory/tool-usage-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("actions:run");

export type ActionLifecycleStage =
  | "started"
  | "executing"
  | "completed"
  | "failed"
  | "rollback_started"
  | "rollback_completed";

export interface ActionLifecycleEvent {
  actionId: string;
  actionName: string;
  stage: ActionLifecycleStage;
  ts: number;
  conversationId?: string;
  message?: string;
}

export interface RunActionOptions<TResult> {
  actionName: string;
  conversationId: string;
  inputSummary?: string;
  riskLevel?: "Low" | "Medium" | "High";
  execute: () => Promise<TResult>;
  rollback?: (ctx: { error: unknown; result?: TResult }) => Promise<void>;
  onLifecycle?: (event: ActionLifecycleEvent) => void | Promise<void>;
}

export async function runAction<TResult>(
  options: RunActionOptions<TResult>,
): Promise<TResult> {
  const actionId = uuid();
  const startedAt = Date.now();
  const riskLevel = options.riskLevel ?? "Medium";
  let result: TResult | undefined;
  let executeError: unknown;

  // Fast path: when no lifecycle subscriber is attached, execute immediately
  // so callers that synchronously inspect side effects after invocation keep
  // existing behavior (e.g. proxy tests asserting request envelopes).
  if (!options.onLifecycle) {
    try {
      result = await options.execute();
      writeAuditLog({
        conversationId: options.conversationId,
        actionName: options.actionName,
        inputSummary: options.inputSummary ?? "{}",
        decision: "allow",
        riskLevel,
        resultSummary: "completed",
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      executeError = err;
      if (options.rollback) {
        try {
          await options.rollback({ error: err, ...(result ? { result } : {}) });
        } catch (rollbackErr) {
          log.warn(
            { actionId, actionName: options.actionName, rollbackErr },
            "Action rollback failed",
          );
        }
      }
      writeAuditLog({
        conversationId: options.conversationId,
        actionName: options.actionName,
        inputSummary: options.inputSummary ?? "{}",
        decision: "deny",
        riskLevel,
        resultSummary: `failed: ${errorMessage(executeError)}`,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const emitLifecycle = (
    stage: ActionLifecycleStage,
    message?: string,
  ): void => {
    if (!options.onLifecycle) return;
    try {
      const maybePromise = options.onLifecycle({
        actionId,
        actionName: options.actionName,
        stage,
        ts: Date.now(),
        conversationId: options.conversationId,
        ...(message ? { message } : {}),
      });
      if (maybePromise instanceof Promise) {
        maybePromise.catch((err) => {
          log.warn(
            { actionId, actionName: options.actionName, stage, err },
            "Action lifecycle subscriber failed (non-fatal)",
          );
        });
      }
    } catch (err) {
      log.warn(
        { actionId, actionName: options.actionName, stage, err },
        "Action lifecycle subscriber failed (non-fatal)",
      );
    }
  };

  emitLifecycle("started");
  emitLifecycle("executing");

  try {
    result = await options.execute();
    emitLifecycle("completed");
    writeAuditLog({
      conversationId: options.conversationId,
      actionName: options.actionName,
      inputSummary: options.inputSummary ?? "{}",
      decision: "allow",
      riskLevel,
      resultSummary: "completed",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    executeError = err;
    emitLifecycle("failed", errorMessage(err));
    if (options.rollback) {
      emitLifecycle("rollback_started");
      try {
        await options.rollback({ error: err, ...(result ? { result } : {}) });
        emitLifecycle("rollback_completed");
      } catch (rollbackErr) {
        log.warn(
          { actionId, actionName: options.actionName, rollbackErr },
          "Action rollback failed",
        );
      }
    }
    writeAuditLog({
      conversationId: options.conversationId,
      actionName: options.actionName,
      inputSummary: options.inputSummary ?? "{}",
      decision: "deny",
      riskLevel,
      resultSummary: `failed: ${errorMessage(executeError)}`,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

function writeAuditLog(options: {
  conversationId: string;
  actionName: string;
  inputSummary: string;
  resultSummary: string;
  decision: "allow" | "deny";
  riskLevel: "Low" | "Medium" | "High";
  durationMs: number;
}): void {
  try {
    recordToolInvocation({
      conversationId: options.conversationId,
      toolName: `action:${options.actionName}`,
      input: options.inputSummary,
      result: options.resultSummary,
      decision: options.decision,
      riskLevel: options.riskLevel,
      durationMs: options.durationMs,
    });
  } catch (err) {
    log.warn(
      { actionName: options.actionName, err },
      "Action audit-log write failed (non-fatal)",
    );
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown action error";
}

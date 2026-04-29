/**
 * Centralized boundary wrapper for background-conversation jobs.
 *
 * `runBackgroundJob()` consolidates the bootstrap → processMessage → timeout
 * pattern that every background producer (heartbeat, filing, scheduler, memory
 * consolidation, watcher, update-bulletin, subagent, sequence) has been
 * open-coding. Wrapping it here lets us:
 *
 *  - apply a single timeout policy
 *  - classify failures uniformly (timeout / model / tool / generic exception)
 *  - emit a single `activity.failed` notification on any failure path so the
 *    home feed and native notification surfaces light up automatically
 *  - never re-throw — the caller always gets a structured result and decides
 *    whether to alert further
 *
 * Producers that have their own bespoke failure UX (e.g. heartbeat's existing
 * alerter banner) can opt out of the failure-emit via
 * `suppressFailureNotifications`.
 *
 * NOTE: This runner is not yet called from any production job. Subsequent PRs
 * migrate each background producer onto it.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { processMessage } from "../daemon/process-message.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import type { TitleOrigin } from "../memory/conversation-title-service.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { AttentionHints } from "../notifications/signal.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("background-job-runner");

const DEFAULT_GROUP_ID = "system:background";

/**
 * Internal-only sentinel for timeouts. Not exported — callers receive a
 * `errorKind: "timeout"` instead so they don't depend on the class identity.
 */
class BackgroundJobTimeoutError extends Error {
  override name = "BackgroundJobTimeoutError";
}

export type BackgroundJobErrorKind =
  | "timeout"
  | "model_provider"
  | "tool"
  | "exception";

export interface RunBackgroundJobOptions {
  /** Short stable identifier for logs/notifications, e.g. "heartbeat", "filing". */
  jobName: string;
  /** Conversation `source` field (free-form, propagated to clients). */
  source: string;
  /** Prompt sent both as `systemHint` to bootstrap and as the first message. */
  prompt: string;
  /** Trust context applied to the agent turn. */
  trustContext: TrustContext;
  /** LLM call-site identifier — drives provider/model/effort/etc. resolution. */
  callSite: LLMCallSite;
  /** Hard timeout for `processMessage` in milliseconds. */
  timeoutMs: number;
  /**
   * When true, failures do NOT emit an `activity.failed` notification.
   * Use for jobs that own their own failure UX (e.g. heartbeat's alerter).
   */
  suppressFailureNotifications?: boolean;
  /** Conversation grouping id. Defaults to `"system:background"`. */
  groupId?: string;
  /** Title origin tag for `bootstrapConversation`. */
  origin: TitleOrigin;
}

export interface RunBackgroundJobResult {
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: BackgroundJobErrorKind;
}

function classifyError(err: unknown): BackgroundJobErrorKind {
  if (err instanceof BackgroundJobTimeoutError) return "timeout";
  if (!(err instanceof Error)) return "exception";

  const ctorName = err.constructor?.name ?? "";
  const { message, name } = err;

  if (
    ctorName.includes("Anthropic") ||
    ctorName.includes("OpenAI") ||
    /\brate\b/i.test(message) ||
    /\b5xx\b/i.test(message) ||
    /\b401\b/.test(message) ||
    /\b403\b/.test(message)
  ) {
    return "model_provider";
  }

  if (name === "ToolExecutionError") return "tool";

  return "exception";
}

/**
 * Run a background conversation job with timeout, error classification, and
 * (by default) failure notification emission. Never re-throws.
 */
export async function runBackgroundJob(
  opts: RunBackgroundJobOptions,
): Promise<RunBackgroundJobResult> {
  const conversation = bootstrapConversation({
    conversationType: "background",
    source: opts.source,
    origin: opts.origin,
    systemHint: opts.prompt,
    groupId: opts.groupId ?? DEFAULT_GROUP_ID,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = processMessage(conversation.id, opts.prompt, undefined, {
      trustContext: opts.trustContext,
      callSite: opts.callSite,
    });
    // Absorb late rejections: if the timeout wins the race, `work` keeps
    // running and may eventually reject — swallow so it doesn't surface as
    // an unhandled rejection.
    work.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new BackgroundJobTimeoutError(
            `Background job '${opts.jobName}' timed out after ${opts.timeoutMs}ms`,
          ),
        );
      }, opts.timeoutMs);
    });

    await Promise.race([work, timeout]);
    return { conversationId: conversation.id, ok: true };
  } catch (err) {
    const errorKind = classifyError(err);
    const error = err instanceof Error ? err : new Error(String(err));

    log.error(
      {
        err: error.message,
        errorKind,
        jobName: opts.jobName,
        conversationId: conversation.id,
      },
      "Background job failed",
    );

    if (!opts.suppressFailureNotifications) {
      const hints: AttentionHints = {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      };
      emitNotificationSignal({
        sourceChannel: "assistant_tool",
        sourceContextId: conversation.id,
        sourceEventName: "activity.failed",
        contextPayload: {
          jobName: opts.jobName,
          errorMessage: error.message,
          errorKind,
        },
        attentionHints: hints,
      }).catch((emitErr) => {
        log.warn(
          {
            err: emitErr instanceof Error ? emitErr.message : String(emitErr),
            jobName: opts.jobName,
            conversationId: conversation.id,
          },
          "Failed to emit activity.failed notification for background job",
        );
      });
    }

    return {
      conversationId: conversation.id,
      ok: false,
      error,
      errorKind,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

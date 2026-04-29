/**
 * Centralized boundary wrapper for background-conversation jobs.
 *
 * `runBackgroundJob()` consolidates the bootstrap → processMessage → timeout
 * pattern that every background producer (heartbeat, filing, scheduler, memory
 * consolidation, watcher, update-bulletin, subagent, sequence) has been
 * open-coding. Wrapping it here lets us:
 *
 *  - apply a single timeout policy
 *  - classify failures uniformly (timeout / model_provider / generic exception)
 *  - emit a single `activity.failed` notification on any failure path so the
 *    home feed and native notification surfaces light up automatically
 *  - never re-throw — the caller always gets a structured result and decides
 *    whether to alert further
 *
 * Producers that have their own bespoke failure UX (e.g. heartbeat's existing
 * alerter banner) can opt out of the failure-emit via
 * `suppressFailureNotifications`.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { processMessage } from "../daemon/process-message.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { addMessage } from "../memory/conversation-crud.js";
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

export type BackgroundJobErrorKind = "timeout" | "model_provider" | "exception";

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
   * Use for jobs that own their own failure UX (e.g. heartbeat's alerter)
   * or for "quiet" scheduled jobs that the user has explicitly asked to
   * suppress notifications for.
   */
  suppressFailureNotifications?: boolean;
  /** Conversation grouping id. Defaults to `"system:background"`. */
  groupId?: string;
  /** Title origin tag for `bootstrapConversation`. */
  origin: TitleOrigin;
  /** Conversation type to bootstrap with. Defaults to `"background"`. */
  conversationType?: "background" | "scheduled";
  /**
   * Schedule job id to associate with the conversation row. Only meaningful
   * for `conversationType: "scheduled"` — propagated so schedule cleanup and
   * sidebar grouping can find the conversation by job id.
   */
  scheduleJobId?: string;
  /**
   * Fires synchronously after `bootstrapConversation` returns and BEFORE
   * `processMessage` starts. Use this to populate the macOS sidebar entry
   * immediately (the SSE event fires when the job starts) rather than after
   * the job finishes (which can be up to `timeoutMs` later for long jobs).
   *
   * Wrapped in try/catch internally — a callback throw is logged and
   * swallowed so it cannot kill the job runner.
   */
  onConversationCreated?: (conversationId: string) => void;
  /**
   * Optional prompt-injection mitigation. When set, the runner adds three
   * messages to the conversation BEFORE invoking `processMessage`:
   *
   *   1. `user` role: `preamble`     — static, trusted instructions.
   *   2. `assistant` role: `content` — attacker-controllable payload (the LLM
   *      treats it as its own past output, not as user instructions).
   *   3. `user` role: `postamble`    — static, trusted action prompt.
   *
   * `processMessage` is then invoked with whatever `prompt` the caller set
   * (often empty or a short kicker) since the conversation already carries
   * the seed.
   *
   * Used by the watcher engine to ingest external provider events safely:
   * a malicious Linear title or Gmail subject reaches the model only in
   * the `assistant` role and cannot override the action prompt.
   */
  assistantSandwich?: { preamble: string; content: string; postamble: string };
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
  const { message } = err;

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
    conversationType: opts.conversationType ?? "background",
    source: opts.source,
    origin: opts.origin,
    systemHint: opts.prompt,
    groupId: opts.groupId ?? DEFAULT_GROUP_ID,
    ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
  });

  // Fire the sidebar-creation callback synchronously after bootstrap so
  // connected clients (macOS sidebar, etc.) see the conversation appear
  // immediately rather than after `processMessage` returns. Wrapped so a
  // callback throw cannot abort the job.
  if (opts.onConversationCreated) {
    try {
      opts.onConversationCreated(conversation.id);
    } catch (cbErr) {
      log.warn(
        {
          err: cbErr instanceof Error ? cbErr.message : String(cbErr),
          jobName: opts.jobName,
          conversationId: conversation.id,
        },
        "onConversationCreated callback threw; continuing job",
      );
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SECURITY: Optional anti-injection sandwich. Attacker-controllable data
    // is wrapped in an assistant-role message between two static user-role
    // messages. The LLM treats assistant-role content as its own prior
    // output, not as user instructions, so a malicious payload (e.g. a
    // crafted Linear title) cannot override the postamble's action prompt.
    if (opts.assistantSandwich) {
      await addMessage(
        conversation.id,
        "user",
        opts.assistantSandwich.preamble,
        undefined,
        { skipIndexing: true },
      );
      await addMessage(
        conversation.id,
        "assistant",
        opts.assistantSandwich.content,
        undefined,
        { skipIndexing: true },
      );
      await addMessage(
        conversation.id,
        "user",
        opts.assistantSandwich.postamble,
        undefined,
        { skipIndexing: true },
      );
    }

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
      // Dedupe by jobName + UTC date so repeated failures of the same
      // background job (e.g. a watcher whose credentials are revoked)
      // collapse into a single home-feed entry per day rather than
      // spamming on every tick.
      const day = new Date().toISOString().slice(0, 10);
      const dedupeKey = `activity-failed:${opts.jobName}:${day}`;
      emitNotificationSignal({
        sourceChannel: "assistant_tool",
        sourceContextId: conversation.id,
        sourceEventName: "activity.failed",
        dedupeKey,
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

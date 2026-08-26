/**
 * Centralized boundary wrapper for background-conversation jobs.
 *
 * `runBackgroundJob()` consolidates the bootstrap → processMessage → timeout
 * pattern that every background producer (heartbeat, filing, scheduler, memory
 * consolidation, watcher, subagent, sequence) has been
 * open-coding. Wrapping it here lets us:
 *
 *  - apply a single timeout policy
 *  - classify failures uniformly (timeout / model_provider / generic exception)
 *  - give every background job a run, so long work is visible while it runs
 *    instead of only when it fails
 *  - roll failures into a System health counter rather than emitting one
 *    notification per occurrence
 *  - never re-throw — the caller always gets a structured result and decides
 *    whether to alert further
 *
 * **Failures are a counter, not a stream.** A background job failing is
 * almost never something the user can act on, and because the notification
 * dedupe window resets daily, one persistent fault used to produce an endless
 * run of identical rows. Each failure now increments one durable row per
 * subsystem, which clears itself once the job succeeds a few times running.
 *
 * Producers that have their own bespoke failure UX (e.g. heartbeat's existing
 * alerter banner) can opt out of the health record via
 * `suppressFailureNotifications`.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { processMessage } from "../daemon/process-message.js";
import type { SubagentToolGateMode } from "../daemon/tool-setup-types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  recordSubsystemFailure,
  recordSubsystemSuccess,
} from "../home/system-health.js";
import { bootstrapConversation } from "../persistence/conversation-bootstrap.js";
import { addMessage } from "../persistence/conversation-crud.js";
import type { TitleOrigin } from "../persistence/conversation-title-service.js";
import { startRun } from "../runs/run-store.js";
import { getLogger } from "../util/logger.js";
import { hasReceivedUserMessage } from "./pre-first-message-gate.js";

const log = getLogger("background-job-runner");

const DEFAULT_GROUP_ID = "system:background";

/**
 * Internal-only sentinel for timeouts. Not exported — callers receive a
 * `errorKind: "timeout"` instead so they don't depend on the class identity.
 */
class BackgroundJobTimeoutError extends Error {
  override name = "BackgroundJobTimeoutError";
}

/**
 * Internal-only sentinel for a turn that failed without throwing. When an LLM
 * call fails (e.g. an invalid provider), `processMessage` resolves normally
 * after persisting a synthetic error message — the failure is reported via
 * `turnFailure` on its result rather than a rejection. We rethrow it as this
 * error so it flows through the same failure path (logging, the System health
 * record, the run's failed transition) as any other background-job failure and
 * the caller gets `ok: false`.
 */
class BackgroundJobTurnFailureError extends Error {
  override name = "BackgroundJobTurnFailureError";
  readonly failureCode: string | undefined;
  constructor(failureCode: string | undefined) {
    super(
      failureCode ? `Agent turn failed (${failureCode})` : "Agent turn failed",
    );
    this.failureCode = failureCode;
  }
}

export type BackgroundJobErrorKind = "timeout" | "model_provider" | "exception";

export interface RunBackgroundJobOptions {
  /** Short stable identifier for logs/notifications, e.g. "heartbeat", "filing". */
  jobName: string;
  /** Conversation `source` field (free-form, propagated to clients). */
  source: string;
  /** Prompt sent as the first message of the conversation. */
  prompt: string;
  /**
   * Short, human-readable hint passed to `bootstrapConversation` for title
   * generation and as the fallback title. Defaults to `prompt` when omitted,
   * but callers with multi-paragraph prompts should supply a concise label
   * (e.g. `"Knowledge base filing"`) — otherwise a fallback title would echo
   * the entire prompt and title-generation requests waste tokens.
   */
  systemHint?: string;
  /** Trust context applied to the agent turn. */
  trustContext: TrustContext;
  /** LLM call-site identifier — drives provider/model/effort/etc. resolution. */
  callSite: LLMCallSite;
  /**
   * Optional ad-hoc inference-profile override (`llm.profiles` key) applied
   * to every LLM call the job's turn issues. Used by schedules with a pinned
   * profile; omitted = the call site's default resolution.
   */
  overrideProfile?: string;
  /**
   * Firing's `cron_runs.id`, threaded into the turn's usage rows so a scheduled
   * execute job attributes its LLM spend to that firing. Omitted for
   * non-scheduled background jobs.
   */
  cronRunId?: string | null;
  /** Hard timeout for `processMessage` in milliseconds. */
  timeoutMs: number;
  /**
   * When true, failures do NOT increment the job's System health counter.
   * Use for jobs that own their own failure UX (e.g. heartbeat's alerter)
   * or for "quiet" scheduled jobs that the user has explicitly asked to
   * suppress notifications for.
   */
  suppressFailureNotifications?: boolean;
  /**
   * How this job's run surfaces.
   *
   * Every background job gets a run so long work is visible while it runs.
   * By default the run is silent: routine infrastructure whose outcome the
   * user did not ask about stays in Activity and never notifies. Jobs that
   * represent work the user kicked off (a detached subagent, skill learning,
   * a scheduled run) opt into notifying transitions.
   */
  run?: {
    /** Run kind. Defaults to `jobName`. */
    kind?: string;
    /** Human label for the row. Defaults to `systemHint`, then `jobName`. */
    label?: string;
    /**
     * Whether the run's terminal transitions can notify. Defaults to false:
     * a routine job's failure belongs in System health, not in the bell.
     */
    notifies?: boolean;
    /** Marks a success as worth showing rather than digest-only. */
    notableOnSuccess?: boolean;
    /** Free-form metadata carried onto the run row. */
    metadata?: Record<string, unknown>;
  };
  /** Conversation grouping id. Defaults to `"system:background"`. */
  groupId?: string;
  /** Title origin tag for `bootstrapConversation`. */
  origin: TitleOrigin;
  /**
   * Origin tag threaded into the agent turn's tool context (and through it
   * `buildPolicyContext`), letting the permission checker scope narrow
   * non-interactive auto-grants to a specific internal background origin
   * (e.g. memory-consolidation skill authoring). Background jobs cannot
   * answer interactive approval prompts, so a job that legitimately needs an
   * otherwise-gated tool opts in by setting this to the origin its grant
   * keys on. Omitted = no origin-scoped grant can fire for the turn.
   */
  requestOrigin?: string;
  /**
   * Restrict the job's agent turn to this exact set of tools. When set, the
   * turn's tool surface is scoped to the allowlist for the duration of the
   * run — used by unattended guardian-trust jobs (e.g. memory consolidation)
   * that must not reach tools they don't need (network egress, host proxy).
   * The run is non-interactive + guardian, so the permission checker
   * auto-approves anything within the background threshold; scoping the
   * surface is what keeps injected buffer/page content from reaching an
   * auto-approved side-effect tool. Omitted = the full conversation tool
   * surface (behavior unchanged for every existing caller).
   */
  allowedTools?: readonly string[];
  /**
   * How {@link allowedTools} is enforced. Defaults to `"wire"` — the excluded
   * tools are never presented to the model (strongest gate; no reliance on
   * the permission checker). See {@link SubagentToolGateMode}. Ignored when
   * `allowedTools` is absent.
   */
  toolGateMode?: SubagentToolGateMode;
  /** Conversation type to bootstrap with. Defaults to `"background"`. */
  conversationType?: "background" | "scheduled";
  /**
   * Schedule job id to associate with the conversation row. Only meaningful
   * for `conversationType: "scheduled"` — propagated so schedule cleanup and
   * sidebar grouping can find the conversation by job id.
   */
  scheduleJobId?: string;
  /**
   * Fires (and is awaited) after `bootstrapConversation` returns and BEFORE
   * `processMessage` starts. Use this to populate the macOS sidebar entry
   * immediately (the SSE event fires when the job starts) rather than after
   * the job finishes (which can be up to `timeoutMs` later for long jobs).
   *
   * Wrapped in try/catch internally — a callback throw (or rejection) is
   * logged and swallowed so it cannot kill the job runner.
   */
  onConversationCreated?: (conversationId: string) => void | Promise<void>;
  /**
   * Opt out of the "skip until first user message" gate. Defaults to
   * `false` (gate active). Set to `true` ONLY for jobs that genuinely need
   * to run pre-onboarding — there are currently none, but the escape hatch
   * exists so the gate can be tightened without trapping a future caller.
   *
   * The gate prevents warm-pool images from generating ghost failure rows
   * before the user ever sees the assistant. See `pre-first-message-gate.ts`.
   */
  allowPreFirstUserMessage?: boolean;
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
  /**
   * Persist the kickoff `prompt` without indexing it — no memory segments,
   * no embeddings, no lexical-index entry. Opt-in for jobs whose prompt is a
   * static machine-authored instruction manual (e.g. memory consolidation)
   * that must not enter memory or search on every run. The run's replies and
   * all other messages index normally. Defaults to false.
   */
  skipPromptIndexing?: boolean;
}

export interface RunBackgroundJobResult {
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: BackgroundJobErrorKind;
  /**
   * Stable classified error code (`ConversationErrorCode`, e.g.
   * `"PROVIDER_BILLING"`) when the turn failed without throwing. Absent for
   * timeouts and thrown exceptions. Lets callers branch on the failure class
   * (e.g. billing vs transient) without depending on error identity or
   * message text.
   */
  failureCode?: string;
  /**
   * Set when the runner declined to execute. Callers can distinguish a
   * skipped job from a successful one even though both report `ok: true`.
   *
   * - `"pre_first_user_message"`: gate tripped — daemon has not yet seen
   *   any user-authored message in a standard conversation. No conversation
   *   was bootstrapped; `conversationId` is the empty string.
   */
  skipReason?: "pre_first_user_message";
}

function classifyError(err: unknown): BackgroundJobErrorKind {
  if (err instanceof BackgroundJobTimeoutError) {
    return "timeout";
  }
  // A non-throwing turn failure is dominated by LLM-call failures (invalid
  // provider, auth, rate limit); bucket it with other provider failures.
  if (err instanceof BackgroundJobTurnFailureError) {
    return "model_provider";
  }
  if (!(err instanceof Error)) {
    return "exception";
  }

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
  // Gate: refuse to bootstrap a conversation until the user has interacted
  // at least once. Warm-pool images would otherwise produce "Background job
  // failed" rows visible in the sidebar the moment a real user hatches the
  // assistant — see `pre-first-message-gate.ts` for the rationale.
  //
  // Service-level callers (e.g. heartbeat) are expected to gate
  // earlier and never reach this point; reaching the gate here means a
  // caller either forgot to gate or deliberately opted in via
  // `allowPreFirstUserMessage`. We log at `info` (not `warn`) because the
  // expected steady state is "no calls reach here once onboarding is done."
  if (!opts.allowPreFirstUserMessage && !hasReceivedUserMessage()) {
    log.info(
      { jobName: opts.jobName, source: opts.source },
      "Background job skipped — daemon has not received a first user message yet",
    );
    return {
      ok: true,
      conversationId: "",
      skipReason: "pre_first_user_message",
    };
  }

  const run = startRun({
    kind: opts.run?.kind ?? opts.jobName,
    label: opts.run?.label ?? opts.systemHint ?? opts.jobName,
    silent: !opts.run?.notifies,
    // A job re-entered by a retry loop within the collapse window is the same
    // work, so it rewrites one row rather than stacking a second.
    collapseKey: `background-job:${opts.jobName}`,
    ...(opts.run?.metadata ? { metadata: opts.run.metadata } : {}),
  });

  let conversation:
    | Awaited<ReturnType<typeof bootstrapConversation>>
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bootstrap inside the try so that a `createConversation` /
    // `queueGenerateConversationTitle` failure is caught and surfaced as a
    // structured `{ ok: false }` result rather than re-thrown to the caller —
    // the documented contract of this runner.
    conversation = await bootstrapConversation({
      conversationType: opts.conversationType ?? "background",
      source: opts.source,
      origin: opts.origin,
      systemHint: opts.systemHint ?? opts.prompt,
      groupId: opts.groupId ?? DEFAULT_GROUP_ID,
      ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
    });

    // Fire the sidebar-creation callback synchronously after bootstrap so
    // connected clients (macOS sidebar, etc.) see the conversation appear
    // immediately rather than after `processMessage` returns. Wrapped so a
    // callback throw cannot abort the job.
    if (opts.onConversationCreated) {
      try {
        await opts.onConversationCreated(conversation.id);
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
        { skipIndexing: true },
      );
      await addMessage(
        conversation.id,
        "assistant",
        opts.assistantSandwich.content,
        { skipIndexing: true },
      );
      await addMessage(
        conversation.id,
        "user",
        opts.assistantSandwich.postamble,
        { skipIndexing: true },
      );
    }

    const work = processMessage(conversation.id, opts.prompt, {
      trustContext: opts.trustContext,
      callSite: opts.callSite,
      ...(opts.overrideProfile
        ? { overrideProfile: opts.overrideProfile }
        : {}),
      ...(opts.requestOrigin ? { requestOrigin: opts.requestOrigin } : {}),
      ...(opts.cronRunId ? { cronRunId: opts.cronRunId } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.toolGateMode ? { toolGateMode: opts.toolGateMode } : {}),
      ...(opts.skipPromptIndexing ? { skipUserMessageIndexing: true } : {}),
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

    const runResult = await Promise.race([work, timeout]);
    // Symmetric with the `work.catch` above: once `work` has won the race,
    // the orphan timeout promise can still reject if the timer fires before
    // the `finally` clears it. Swallow so it doesn't surface as an unhandled
    // rejection that Bun can use to terminate the process.
    timeout.catch(() => {});
    // The turn completed but its LLM call failed (e.g. an invalid provider):
    // `processMessage` reports this via `turnFailure` instead of throwing.
    // Rethrow so it flows through the shared failure path below (logging +
    // `activity.failed` emission) rather than returning `ok: true`.
    if (runResult.turnFailure) {
      throw new BackgroundJobTurnFailureError(
        runResult.turnFailure.failureCode,
      );
    }
    if (!opts.suppressFailureNotifications) {
      void recordSubsystemSuccess(opts.jobName);
    }
    await run.succeed({
      notable: opts.run?.notableOnSuccess ?? false,
      conversationId: conversation.id,
    });
    return { conversationId: conversation.id, ok: true };
  } catch (err) {
    const errorKind = classifyError(err);
    const error = err instanceof Error ? err : new Error(String(err));
    const failureCode =
      err instanceof BackgroundJobTurnFailureError
        ? err.failureCode
        : undefined;
    // Bootstrap can fail before `conversation` is assigned; fall back to ""
    // so the structured failure result still flows to the caller.
    const conversationId = conversation?.id ?? "";

    log.error(
      {
        err: error.message,
        errorKind,
        jobName: opts.jobName,
        conversationId,
      },
      "Background job failed",
    );

    // One durable row per failing job, counting, rather than one notification
    // per failure. A provider timeout is not something the user can fix, and
    // the row clears itself once the job succeeds a few times running.
    if (!opts.suppressFailureNotifications) {
      void recordSubsystemFailure({
        subsystem: opts.jobName,
        label: opts.run?.label ?? humanizeJobName(opts.jobName),
        errorSummary: describeFailure(errorKind, error.message),
        ...(conversationId ? { conversationId } : {}),
      });
    }

    await run.fail({
      reason: describeFailure(errorKind, error.message),
      // Nothing here re-runs itself, and a routine job is on a timer that will
      // come round again anyway, so Retry is offered only where a person
      // asked for the work.
      retryable: opts.run?.notifies ?? false,
    });

    return {
      conversationId,
      ok: false,
      error,
      errorKind,
      ...(failureCode !== undefined ? { failureCode } : {}),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Turn an internal job id into something a person can read on a health row:
 * `memory_consolidation` becomes `Memory consolidation`.
 */
function humanizeJobName(jobName: string): string {
  const spaced = jobName.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0
    ? jobName
    : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A failure in prose rather than as a log line.
 *
 * The classified kind carries the part a reader can act on ("the model
 * provider did not respond"), and the raw message is appended only when it
 * adds something: a stack-shaped or constant-shaped message says nothing to
 * the person reading the bell, and the copy contract exists to keep it out.
 */
function describeFailure(kind: BackgroundJobErrorKind, message: string): string {
  const opening =
    kind === "timeout"
      ? "It ran out of time before finishing."
      : kind === "model_provider"
        ? "The model provider did not answer."
        : "It stopped with an error.";
  const detail = message.replace(/\s+/g, " ").trim();
  const readable =
    detail.length > 0 &&
    detail.length <= 140 &&
    !/^[A-Z][A-Z0-9_]*$/.test(detail);
  return readable ? `${opening} ${detail}` : opening;
}

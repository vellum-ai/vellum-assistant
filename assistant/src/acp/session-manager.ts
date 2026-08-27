/**
 * ACP session manager — orchestrates ACP agent process lifecycles with
 * concurrency control, permission resolution, and session state tracking.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { eq, inArray } from "drizzle-orm";

import type { AcpSessionUpdateEvent } from "../api/events/acp-session-update.js";
import type { AssistantEvent } from "../api/index.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import {
  acpAuthMarkerStillCurrent,
  noteClaudeTokenRefused,
} from "./acp-auth-marker-store.js";
import { markAcpConnectCardRaised } from "./acp-connect-card-state.js";
import { AcpAgentProcess } from "./agent-process.js";
import {
  ACP_AUTH_RECOVERY_GUIDANCE,
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  CLAUDE_ACP_COMMAND,
  isAcpAuthRequired,
  isClaudeAuthFailureMessage,
} from "./auth-required.js";
import { resolveAgentWithAutoInstall } from "./auto-install.js";
import { VellumAcpClientHandler } from "./client-handler.js";
import { deriveFailureError } from "./failure-error.js";
import { prepareAgentEnv } from "./prepare-agent-env.js";
import { formatResolveFailure } from "./resolve-agent.js";
import { claudeResumeHint } from "./resume-hint.js";
import type { AcpAgentConfig, AcpSessionState } from "./types.js";

const log = getLogger("acp:session-manager");

/**
 * The `authCode` for a run that failed on its Claude credential, or undefined
 * for any other failure. Adapter-gated first: the signals are Claude-specific,
 * and the marker promises a repair only the Connect Claude flow can perform.
 * Checks both auth-failure shapes (see `auth-required.ts`) against both the
 * raw rejection and the derived failure message, since `deriveFailureError`
 * may replace one with the other.
 */
function claudeAuthRequiredCode(
  err: unknown,
  failureMessage: string,
  entry: { command: string },
): string | undefined {
  if (entry.command !== CLAUDE_ACP_COMMAND) {
    return undefined;
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  return isAcpAuthRequired(err) ||
    isClaudeAuthFailureMessage(rawMessage) ||
    isClaudeAuthFailureMessage(failureMessage)
    ? ACP_CLAUDE_AUTH_REQUIRED_CODE
    : undefined;
}

/**
 * The manager's "unknown session id" error. Thrown whenever an operation
 * references an acpSessionId with no in-memory entry (and, for resume, no
 * persisted history row). Callers (acp_steer tool, /v1/acp/:id/steer route)
 * use `instanceof` checks to map this to their transport's not-found shape.
 */
export class AcpSessionNotFoundError extends Error {
  constructor(public readonly acpSessionId: string) {
    super(`ACP session "${acpSessionId}" not found`);
    this.name = "AcpSessionNotFoundError";
  }
}

/**
 * Wraps failures from the resume-then-steer phase of `steerOrResume` so
 * transport callers can distinguish them (HTTP 424 with the actionable
 * resume hint) from plain steer failures (404). The message mirrors the
 * underlying error's message; the original error rides on `cause`.
 */
export class AcpResumeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AcpResumeError";
  }
}

/** Maximum number of update events kept in a session's ring buffer. */
const MAX_BUFFER_EVENTS = 200;
/** Maximum aggregate JSON size of a session's ring buffer, in bytes. */
const MAX_BUFFER_BYTES = 256 * 1024;

interface BufferedAcpUpdate {
  /** The wire-shaped update — exactly what was forwarded to clients. */
  update: AcpSessionUpdateEvent;
  /** Cached UTF-8 byte length of `JSON.stringify(update)` for cap math. */
  byteSize: number;
}

interface SessionEntry {
  process: AcpAgentProcess;
  state: AcpSessionState;
  clientHandler: VellumAcpClientHandler;
  /** Wrapped sender that also appends to the ring buffer. */
  sendToVellum: (msg: AssistantEvent) => void;
  currentPrompt: Promise<unknown> | null;
  parentConversationId: string;
  cwd: string;
  /** Tool-use id of the `acp_spawn` call that spawned this session, if any. */
  parentToolUseId?: string;
  /** Objective text the session was spawned with, if known. */
  task?: string;
  /** Resolved adapter command basename (e.g. "claude-agent-acp"). Used to
   *  gate resume hints to the only adapter (claude-agent-acp) whose CLI
   *  accepts `--resume`. */
  command: string;
  /** Identity of the Claude token this session ran with, whichever source it
   *  came from. Recorded on the history row alongside the failure code, so the
   *  marker can be compared against the credential a later spawn resolves
   *  rather than needing a sweep to retire it. Absent for agents that use no
   *  Claude credential. */
  credentialDigest?: string;
}

/**
 * An `acp_session_history` row that passed resumeFromHistory's validation
 * guards: `cwd` (nullable in the schema for pre-resume-support rows) is
 * guaranteed present.
 */
type ResumableHistoryRow = typeof acpSessionHistory.$inferSelect & {
  cwd: string;
};

export class AcpSessionManager {
  private sessions = new Map<string, SessionEntry>();
  /**
   * Per-session ring buffer of wire-shaped update events forwarded to
   * clients. Bounded by event count and aggregate JSON byte size; oldest
   * events are dropped first when caps are exceeded. Persisted to
   * `acp_session_history` on terminal transition, then cleared.
   */
  private eventBuffers = new Map<string, BufferedAcpUpdate[]>();
  /**
   * In-flight resumes by session id, keyed to the promise of the resume's
   * async body. Reserved SYNCHRONOUSLY before the first await so concurrent
   * resumes of the same id cannot both pass the guards (the loser would
   * overwrite the winner's map entry and leak its child process), and so N
   * concurrent resumes of distinct ids cannot exceed maxConcurrent. The
   * entry lives until the resume settles so `steerOrResume` can await a
   * concurrent caller's resume instead of failing the already-active guard.
   * The spawn path needs no such reservation: its check-then-register is
   * synchronous.
   */
  private pendingResumes = new Map<string, Promise<void>>();

  /**
   * Set by dispose() (the daemon-shutdown path). Resumes that are mid-await
   * when the manager is disposed re-check this flag before spawning a child
   * process nothing would ever kill.
   */
  private disposed = false;

  constructor(private readonly maxConcurrent: number) {
    this.cleanupStaleRunningRows();
  }

  /**
   * On daemon boot, flip any `running`/`initializing` rows in
   * `acp_session_history` to `cancelled` with a `daemon_restarted` stop
   * reason. The in-memory ACP sessions they represent died with the
   * previous daemon process, so the persisted rows would otherwise lie to
   * the sessions UI about their status.
   *
   * Idempotent: a second invocation finds no matching rows (status is
   * already `cancelled`) and is a no-op. Best-effort: a DB failure is
   * logged but does not propagate, since failing to clean up stale rows
   * must not block daemon startup.
   */
  private cleanupStaleRunningRows(): void {
    try {
      getDb()
        .update(acpSessionHistory)
        .set({
          status: "cancelled",
          stopReason: "daemon_restarted",
          completedAt: Date.now(),
        })
        .where(inArray(acpSessionHistory.status, ["running", "initializing"]))
        .run();
    } catch (err) {
      log.error(
        { err },
        "Failed to mark stale ACP sessions as daemon_restarted",
      );
    }
  }

  /**
   * Ids that must be treated as live: registered sessions plus in-flight
   * resume reservations (deduped, since a resuming session appears in both maps
   * between registration and settle). Delete guards use this so a history
   * row cannot be removed out from under a resume that is still awaiting
   * env preparation; the later terminal upsert would resurrect it.
   */
  getActiveAndPendingIds(): string[] {
    return [
      ...new Set([...this.sessions.keys(), ...this.pendingResumes.keys()]),
    ];
  }

  /**
   * Concurrency guard shared by spawn() and resumeFromHistory(). Counts
   * both registered sessions and in-flight resume reservations so the cap
   * holds even while a resume is still awaiting prepareAgentEnv.
   */
  private assertCapacity(): void {
    if (this.getActiveAndPendingIds().length >= this.maxConcurrent) {
      throw new Error(
        `ACP concurrency limit reached (max ${this.maxConcurrent}). ` +
          `Close an existing session before spawning a new one.`,
      );
    }
  }

  /**
   * Spawns a new ACP agent session. Returns the generated acpSessionId.
   *
   * The prompt is fired in the background — results stream via sessionUpdate
   * callbacks and completion/error messages are sent when the prompt finishes.
   */
  async spawn(
    agentId: string,
    agentConfig: AcpAgentConfig,
    task: string,
    cwd: string,
    parentConversationId: string,
    sendToVellum: (msg: AssistantEvent) => void,
    parentToolUseId?: string,
  ): Promise<{ acpSessionId: string; protocolSessionId: string }> {
    this.assertCapacity();

    const acpSessionId = randomUUID();
    log.info(
      {
        acpSessionId,
        agentId,
        task: task.slice(0, 200),
        cwd,
        parentConversationId,
      },
      "ACP spawn requested",
    );

    const entry = this.registerSession({
      acpSessionId,
      agentId,
      agentConfig,
      parentConversationId,
      cwd,
      startedAt: Date.now(),
      sendToVellum,
      parentToolUseId,
      task,
    });
    const { process: agentProcess, state } = entry;

    try {
      log.info({ acpSessionId, agentId }, "ACP spawning child process");
      agentProcess.spawn(cwd);
      log.info(
        { acpSessionId, agentId },
        "ACP initializing protocol connection",
      );
      await agentProcess.initialize();
      log.info({ acpSessionId, agentId }, "ACP creating session");
      const acpProtocolSessionId = await agentProcess.createSession(cwd);
      state.acpSessionId = acpProtocolSessionId;
      state.status = "running";
      log.info(
        { acpSessionId, agentId, acpProtocolSessionId },
        "ACP session running",
      );
    } catch (err) {
      log.error({ acpSessionId, agentId, err }, "ACP spawn failed");
      // Here rather than at the tool boundary, because the HTTP spawn route
      // reaches this method directly and would otherwise never record it. A
      // configured CLAUDE_CODE_OAUTH_TOKEN that Claude refused keeps winning
      // over whatever Connect stores until this is written down, so every
      // later spawn repeats the same failure.
      if (isAcpAuthRequired(err)) {
        noteClaudeTokenRefused(agentConfig.credentialDigest, Date.now());
      }
      // No prompt has fired yet, so no permissions can be pending.
      this.teardownSession(acpSessionId, entry);
      throw err;
    }

    this.sendSpawnedEvent(acpSessionId, entry);

    // Fire prompt in the background — don't await
    entry.currentPrompt = this.firePromptInBackground(
      acpSessionId,
      entry,
      state.acpSessionId,
      task,
    );

    return { acpSessionId, protocolSessionId: state.acpSessionId };
  }

  /**
   * Wires up the in-memory plumbing shared by spawn() and
   * resumeFromHistory(): the per-session ring buffer, the buffer-mirroring
   * sender, the client handler, the agent process, and the SessionEntry.
   * Registers the entry in the session map (reserving a concurrency slot
   * before any async work) and returns it. Does NOT start the process.
   */
  private registerSession(opts: {
    acpSessionId: string;
    agentId: string;
    agentConfig: AcpAgentConfig;
    parentConversationId: string;
    cwd: string;
    startedAt: number;
    sendToVellum: (msg: AssistantEvent) => void;
    parentToolUseId?: string;
    task?: string;
  }): SessionEntry {
    const { acpSessionId } = opts;

    // Initialize the per-session ring buffer before any update can fire.
    this.eventBuffers.set(acpSessionId, []);

    // Wrap the sender so every emitted message is mirrored into the buffer
    // when it's an `acp_session_update`. The wrapper preserves the original
    // call semantics: it forwards every message unchanged.
    const wrappedSend = (msg: AssistantEvent) => {
      if (msg.type === "acp_session_update") {
        this.appendToBuffer(acpSessionId, msg);
      } else if (msg.type === "acp_session_usage") {
        // Track the latest usage gauge so a terminal transition can persist
        // the final snapshot.
        const state = this.sessions.get(acpSessionId)?.state;
        if (state) {
          state.latestUsage = {
            usedTokens: msg.usedTokens,
            contextSize: msg.contextSize,
            costAmount: msg.costAmount,
            costCurrency: msg.costCurrency,
            inputTokens: msg.inputTokens ?? state.latestUsage?.inputTokens,
            outputTokens: msg.outputTokens ?? state.latestUsage?.outputTokens,
          };
        }
      }
      opts.sendToVellum(msg);
    };

    const clientHandler = new VellumAcpClientHandler(
      acpSessionId,
      wrappedSend,
      opts.parentConversationId,
    );

    const agentProcess = new AcpAgentProcess(
      opts.agentId,
      opts.agentConfig,
      (_agent) => clientHandler,
    );

    const state: AcpSessionState = {
      id: acpSessionId,
      agentId: opts.agentId,
      acpSessionId: "", // placeholder until createSession/resume resolves
      parentConversationId: opts.parentConversationId,
      status: "initializing",
      startedAt: opts.startedAt,
      task: opts.task,
      parentToolUseId: opts.parentToolUseId,
    };

    const entry: SessionEntry = {
      process: agentProcess,
      state,
      clientHandler,
      sendToVellum: wrappedSend,
      currentPrompt: null,
      parentConversationId: opts.parentConversationId,
      cwd: opts.cwd,
      parentToolUseId: opts.parentToolUseId,
      task: opts.task,
      command: basename(opts.agentConfig.command),
      credentialDigest: opts.agentConfig.credentialDigest,
    };

    this.sessions.set(acpSessionId, entry);
    return entry;
  }

  /**
   * Notifies connected clients that a session is live. Shared by spawn()
   * and the resume path (resumed sessions reuse the spawned event so
   * clients render them; a dedicated acp_session_resumed event is a
   * possible follow-up, not in scope here).
   */
  private sendSpawnedEvent(acpSessionId: string, entry: SessionEntry): void {
    entry.sendToVellum({
      type: "acp_session_spawned",
      acpSessionId,
      agent: entry.state.agentId,
      parentConversationId: entry.parentConversationId,
      parentToolUseId: entry.parentToolUseId,
      task: entry.task,
    });
  }

  /**
   * Resumes a terminal-state session from its persisted
   * `acp_session_history` row, reattaching to the agent's stored
   * conversation via ACP `session/resume` (preferred: no history replay) or
   * `session/load` (replayed history is suppressed; see
   * VellumAcpClientHandler.beginReplaySuppression).
   *
   * The resumed session reuses the original vellum session id,
   * parentConversationId, and startedAt, and re-seeds its ring buffer from
   * the persisted event log so the terminal upsert after the resumed run
   * merges new events into the original row instead of losing them.
   *
   * Throws with an actionable message when the row is missing, was recorded
   * before resume support (no cwd), the agent cannot be resolved or
   * auto-installed, or the agent advertises neither resume capability.
   */
  async resumeFromHistory(
    acpSessionId: string,
    sendToVellum: (msg: AssistantEvent) => void,
  ): Promise<void> {
    if (
      this.sessions.has(acpSessionId) ||
      this.pendingResumes.has(acpSessionId)
    ) {
      throw new Error(`ACP session "${acpSessionId}" is already active`);
    }
    this.assertCapacity();

    const row = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, acpSessionId))
      .get();
    if (!row) {
      throw new AcpSessionNotFoundError(acpSessionId);
    }
    if (!row.cwd) {
      throw new Error(
        `ACP session "${acpSessionId}" was recorded before resume support ` +
          `(no working directory persisted) and cannot be resumed. ` +
          `Spawn a new session instead.`,
      );
    }
    if (!row.acpSessionId) {
      throw new Error(
        `ACP session "${acpSessionId}" has no protocol session id ` +
          `persisted and cannot be resumed. Spawn a new session instead.`,
      );
    }

    // Everything up to here is synchronous. Reserve the id + concurrency
    // slot BEFORE the first await so a concurrent resume of the same id
    // (or a spawn racing the cap) fails the guards above instead of
    // double-registering and leaking the first child process. The
    // reservation holds the resume's promise until it settles so
    // steerOrResume can await a concurrent caller's in-flight resume, and
    // so the delete guards see the id as live while the row's terminal
    // status still reflects the previous run. Agent resolution (which may
    // auto-install a missing adapter) is therefore deferred into
    // performResume, after the slot is reserved.
    const resumePromise = this.performResume(
      acpSessionId,
      row as ResumableHistoryRow,
      sendToVellum,
    );
    this.pendingResumes.set(acpSessionId, resumePromise);
    try {
      await resumePromise;
    } finally {
      this.pendingResumes.delete(acpSessionId);
    }
  }

  /**
   * The async body of resumeFromHistory, split out so the caller can store
   * its promise in `pendingResumes` synchronously before the first await.
   * All guards and row validation have already passed; this resolves the
   * adapter (auto-installing a missing allowlisted binary), prepares its
   * env, and reattaches.
   */
  private async performResume(
    acpSessionId: string,
    row: ResumableHistoryRow,
    sendToVellum: (msg: AssistantEvent) => void,
  ): Promise<void> {
    // Resolve the adapter, silently auto-installing a missing allowlisted
    // binary via the same sandboxed `bun` path as spawn (see
    // acp/auto-install.ts). A fresh container, or a session created under
    // the old bunx fallback, may have no adapter on PATH; resume installs it
    // transparently instead of failing with binary_not_found. The token is
    // NEVER in scope here — resolveAgentWithAutoInstall strips it from the
    // installer env; it is injected only by prepareAgentEnv below, at spawn
    // time, on the real installed binary.
    const { resolved, failureMessage } = await resolveAgentWithAutoInstall(
      row.agentId,
    );
    if (failureMessage) {
      throw new Error(failureMessage);
    }
    if (!resolved.ok) {
      throw new Error(formatResolveFailure(row.agentId, resolved));
    }

    const agentConfig = await prepareAgentEnv(resolved.agent);

    // The daemon may have shut down while prepareAgentEnv was pending.
    // Registering now would spawn a child process on a disposed manager
    // that nothing would ever kill.
    if (this.disposed) {
      throw new Error(
        `ACP session manager is disposed; cannot resume session "${acpSessionId}"`,
      );
    }

    const entry = this.registerSession({
      acpSessionId,
      agentId: row.agentId,
      agentConfig,
      parentConversationId: row.parentConversationId,
      cwd: row.cwd,
      startedAt: row.startedAt,
      sendToVellum,
      // Carry the persisted metadata onto the fresh in-memory state so the
      // next terminal upsert rewrites the same values instead of NULLing
      // them. A resumed run only emits a usage_update if it does fresh work;
      // without seeding, a resume->re-terminate would clobber the stored
      // task/parentToolUseId/usage.
      task: row.task ?? undefined,
      parentToolUseId: row.parentToolUseId ?? undefined,
    });

    log.info(
      { acpSessionId, agentId: row.agentId, cwd: row.cwd },
      "ACP resume from history requested",
    );
    const { process: agentProcess, state } = entry;

    // Seed the latest usage snapshot from the persisted columns. A fresh
    // usage_update during the resumed run overwrites this; if none fires the
    // prior snapshot is re-persisted on terminal transition. Pre-migration
    // rows have null token columns and leave latestUsage undefined.
    if (row.usedTokens !== null && row.contextSize !== null) {
      state.latestUsage = {
        usedTokens: row.usedTokens,
        contextSize: row.contextSize,
        costAmount: row.costAmount ?? undefined,
        costCurrency: row.costCurrency ?? undefined,
        inputTokens: row.inputTokens ?? undefined,
        outputTokens: row.outputTokens ?? undefined,
      };
    }

    // Re-seed the ring buffer from the persisted event log, routed through
    // appendToBuffer so the count/byte caps still apply. The terminal
    // upsert then persists the merged (old + new) log. Track the highest
    // persisted seq and advance the fresh handler's counter to it so live
    // updates after resume continue strictly increasing instead of resetting
    // to 1 (which the web client would drop as seq <= highWaterMark).
    let maxSeq = 0;
    try {
      const persisted = JSON.parse(row.eventLogJson) as unknown;
      if (Array.isArray(persisted)) {
        for (const update of persisted) {
          this.appendToBuffer(acpSessionId, update as AcpSessionUpdateEvent);
          const seq = (update as AcpSessionUpdateEvent)?.seq;
          if (typeof seq === "number" && seq > maxSeq) {
            maxSeq = seq;
          }
        }
      }
    } catch (err) {
      log.warn(
        { acpSessionId, err },
        "Failed to re-seed ACP event buffer from persisted history",
      );
    }
    // Seed before the child process spawns so no live update can fire first.
    entry.clientHandler.seedSeq(maxSeq);

    try {
      log.info(
        { acpSessionId, agentId: row.agentId },
        "ACP spawning child process for resume",
      );
      agentProcess.spawn(row.cwd);
      await agentProcess.initialize();
      if (agentProcess.supportsSessionResume) {
        // session/resume reattaches without replaying history.
        await agentProcess.resumeSession(row.acpSessionId, row.cwd);
      } else if (agentProcess.supportsLoadSession) {
        // session/load replays the full history as session/update
        // notifications before resolving; suppress forwarding so the
        // conversation and ring buffer don't receive duplicates.
        entry.clientHandler.beginReplaySuppression();
        try {
          await agentProcess.loadSession(row.acpSessionId, row.cwd);
        } finally {
          entry.clientHandler.endReplaySuppression();
        }
      } else {
        throw new Error(
          `ACP agent "${row.agentId}" does not support session resume`,
        );
      }
      state.acpSessionId = row.acpSessionId;
      state.status = "running";
      log.info(
        {
          acpSessionId,
          agentId: row.agentId,
          protocolSessionId: row.acpSessionId,
        },
        "ACP session resumed",
      );
    } catch (err) {
      log.error(
        { acpSessionId, agentId: row.agentId, err },
        "ACP resume failed",
      );
      // No prompt has fired yet, so no permissions can be pending.
      this.teardownSession(acpSessionId, entry);
      throw err;
    }

    this.sendSpawnedEvent(acpSessionId, entry);
  }

  /**
   * Sends a follow-up instruction to an existing session.
   *
   * Cancels any in-flight prompt first, then fires the new prompt in the
   * background with completion/error event handlers (matching spawn's pattern).
   */
  async steer(acpSessionId: string, instruction: string): Promise<void> {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new AcpSessionNotFoundError(acpSessionId);
    }

    if (entry.state.status !== "running") {
      throw new Error(
        `ACP session "${acpSessionId}" is not running (status: ${entry.state.status})`,
      );
    }

    // Cancel any in-flight prompt before starting a new one.
    // Clear currentPrompt BEFORE awaiting cancel so the old prompt's
    // catch handler sees currentPrompt !== promptPromise and skips teardown.
    if (entry.currentPrompt) {
      entry.currentPrompt = null;
      try {
        await entry.process.cancel(entry.state.acpSessionId);
      } catch (err) {
        log.warn(
          { acpSessionId, err },
          "Failed to cancel in-flight prompt before steer",
        );
      }
    }

    // Fire new prompt in the background with event handlers
    entry.currentPrompt = this.firePromptInBackground(
      acpSessionId,
      entry,
      entry.state.acpSessionId,
      instruction,
    );
  }

  /**
   * Steers a session, transparently resuming it from persisted history
   * first when it is no longer in memory (it completed, or the daemon
   * restarted). The resume and the instruction prompt are atomic from the
   * caller's perspective: a successfully resumed session immediately gets
   * the instruction fired, so it never sits running-idle with no in-flight
   * prompt (and therefore no teardown owner). If the post-resume steer
   * fails, the freshly resumed session is closed (process killed, terminal
   * row persisted, maps cleared) instead of being leaked.
   *
   * When a concurrent caller's resume of the same id is already in flight,
   * this call awaits that resume and then retries the plain steer, so both
   * callers' instructions land on the single resumed session.
   *
   * Error contract for transport callers (acp_steer tool, steer route):
   * - `AcpSessionNotFoundError`: no in-memory session AND no history row.
   * - `AcpResumeError`: the resume (own or a concurrent caller's awaited
   *   one, or the steer immediately after an own resume) failed; the
   *   message carries the actionable hint.
   * - any other error: the plain steer on an in-memory session failed.
   */
  async steerOrResume(
    acpSessionId: string,
    instruction: string,
    sendToVellum: (msg: AssistantEvent) => void,
  ): Promise<{ resumed: boolean }> {
    try {
      await this.steer(acpSessionId, instruction);
      return { resumed: false };
    } catch (err) {
      // Fall through to the in-flight-resume handling both when the session
      // is entirely unknown and when a concurrent resume has already
      // registered its entry but is still initializing: steer rejects with a
      // plain not-running error in that window, yet the resume reservation
      // is live and the retry below will land once it settles.
      if (
        !(err instanceof AcpSessionNotFoundError) &&
        !this.pendingResumes.has(acpSessionId)
      ) {
        throw err;
      }
    }

    // Another caller's resume of this id may already be in flight (the
    // session is not in memory yet, but its slot is reserved). Await that
    // resume and retry the plain steer once instead of failing
    // resumeFromHistory's already-active guard, which would surface a
    // misleading resume error and drop this instruction.
    const inFlightResume = this.pendingResumes.get(acpSessionId);
    if (inFlightResume) {
      try {
        await inFlightResume;
      } catch (err) {
        throw new AcpResumeError(err);
      }
      // The resumed session is owned by the concurrent caller (its own
      // post-resume steer handles teardown on failure), so a failure here
      // propagates as a plain steer error without closing the session.
      await this.steer(acpSessionId, instruction);
      return { resumed: true };
    }

    try {
      await this.resumeFromHistory(acpSessionId, sendToVellum);
    } catch (err) {
      // A missing history row keeps its not-found shape; everything else
      // (legacy row without cwd, resolver failure, capability missing)
      // is a resume failure with an actionable message.
      if (err instanceof AcpSessionNotFoundError) {
        throw err;
      }
      throw new AcpResumeError(err);
    }

    try {
      await this.steer(acpSessionId, instruction);
    } catch (err) {
      // Tear down the just-resumed session rather than leaving it
      // running-idle with no prompt handler to own its cleanup.
      try {
        this.close(acpSessionId);
      } catch (closeErr) {
        log.warn(
          { acpSessionId, err: closeErr },
          "Failed to close ACP session after post-resume steer failure",
        );
      }
      throw new AcpResumeError(err);
    }
    return { resumed: true };
  }

  /**
   * Cancels an ongoing prompt in the specified session.
   *
   * When a prompt is in flight, its `prompt()` call rejects in response
   * and the catch handler in `firePromptInBackground` performs the
   * terminal persistence + teardown; we just flip the status here so that
   * handler preserves "cancelled" instead of overwriting with "failed".
   *
   * When NO prompt is in flight there is no handler to own cleanup, so
   * cancel persists and tears down the session itself. (Sessions normally
   * always have a prompt in flight, but a cancel can race the window in
   * steer() between clearing the old prompt and firing the new one.)
   */
  async cancel(acpSessionId: string): Promise<void> {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new AcpSessionNotFoundError(acpSessionId);
    }
    // Mark cancelled BEFORE awaiting the protocol cancel. If the in-flight
    // prompt rejects during this window, its catch handler must already see
    // "cancelled" so it neither overwrites the status with "failed" nor wakes
    // the parent — no model activity may follow a user stop.
    const prevStatus = entry.state.status;
    const prevCompletedAt = entry.state.completedAt;
    entry.state.status = "cancelled";
    entry.state.completedAt = Date.now();
    try {
      await entry.process.cancel(entry.state.acpSessionId);
    } catch (err) {
      // The protocol cancel failed (e.g. the adapter connection is already
      // down): the session was NOT actually cancelled, so restore the prior
      // status. Otherwise the still-running prompt's eventual completion would
      // be wrongly suppressed and persisted as cancelled. Rethrow so the caller
      // reports failure and the client rolls back its optimistic cancel.
      if (this.sessions.get(acpSessionId) === entry) {
        entry.state.status = prevStatus;
        entry.state.completedAt = prevCompletedAt;
      }
      throw err;
    }
    // Re-check the map after the await: the in-flight prompt's handler may
    // have already torn the session down while process.cancel was pending.
    if (!entry.currentPrompt && this.sessions.get(acpSessionId) === entry) {
      this.persistTerminal(acpSessionId, entry);
      this.teardownSession(acpSessionId, entry);
    }
  }

  /**
   * Cancels every in-flight session spawned by `parentConversationId`.
   *
   * Mirrors the subagent manager's `abortAllForParent`: when the user cancels
   * a turn, the ACP agents it launched should stop rather than keep running in
   * the background — holding a child process — and then, on completion, enqueue
   * a follow-up message into the conversation the user just stopped. Cancelling
   * settles each in-flight prompt down its `"cancelled"` path, which sends a
   * client event but does NOT notify the parent, so no model activity follows
   * the stop.
   *
   * Each session's `cancel()` runs detached (it awaits a protocol notification
   * to the child) so callers on the cancel hot path never block on an
   * unresponsive agent; failures are logged. Session ids are snapshotted before
   * dispatch so concurrent teardown can't disturb the iteration. Returns the
   * number of sessions a cancel was kicked off for.
   */
  cancelForParent(parentConversationId: string): number {
    const ids: string[] = [];
    for (const [acpSessionId, entry] of this.sessions) {
      if (entry.parentConversationId === parentConversationId) {
        ids.push(acpSessionId);
      }
    }
    for (const acpSessionId of ids) {
      void this.cancel(acpSessionId).catch((err) => {
        log.warn(
          { acpSessionId, parentConversationId, err },
          "Failed to cancel ACP session on parent cancel",
        );
      });
    }
    return ids.length;
  }

  /**
   * Kills the agent process and removes the session from tracking.
   *
   * Persists the buffered event log first so abort paths
   * (`executeAcpAbort`, daemon shutdown) don't drop history. If the
   * session is still in a non-terminal state, mark it cancelled so the
   * persisted row reflects reality. The in-flight prompt's then/catch
   * handler will short-circuit after teardown removes the entry.
   */
  close(acpSessionId: string): void {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new AcpSessionNotFoundError(acpSessionId);
    }
    if (
      entry.state.status === "running" ||
      entry.state.status === "initializing"
    ) {
      entry.state.status = "cancelled";
      entry.state.completedAt = Date.now();
    }
    this.persistTerminal(acpSessionId, entry);
    this.teardownSession(acpSessionId, entry);
  }

  /**
   * Denies pending ACP permissions, kills the process, and removes the session.
   */
  private teardownSession(acpSessionId: string, entry: SessionEntry): void {
    for (const requestId of entry.clientHandler.pendingRequestIds) {
      const interaction = pendingInteractions.resolve(requestId, "cancelled");
      if (interaction?.directResolve) {
        interaction.directResolve("deny");
      }
    }
    entry.process.kill();
    this.sessions.delete(acpSessionId);
    // Free the buffer in case persistTerminal hasn't already (e.g. close()
    // before terminal transition).
    this.eventBuffers.delete(acpSessionId);
  }

  /**
   * Kills all agent processes and clears the session map.
   */
  closeAll(): void {
    for (const acpSessionId of [...this.sessions.keys()]) {
      this.close(acpSessionId);
    }
  }

  /**
   * Returns session state(s). If acpSessionId is provided, returns that
   * session's state; otherwise returns all session states.
   */
  getStatus(acpSessionId?: string): AcpSessionState | AcpSessionState[] {
    if (acpSessionId) {
      const entry = this.sessions.get(acpSessionId);
      if (!entry) {
        throw new AcpSessionNotFoundError(acpSessionId);
      }
      return entry.state;
    }
    return Array.from(this.sessions.values()).map((e) => e.state);
  }

  /**
   * Returns the live ring buffer for an active session as wire-shaped
   * `AcpSessionUpdateEvent[]` (each carrying `seq`), matching exactly what
   * `persistTerminal` serializes to `eventLogJson` on terminal transition.
   * Empty array for unknown/already-torn-down ids.
   */
  getBufferedUpdates(acpSessionId: string): AcpSessionUpdateEvent[] {
    const buffer = this.eventBuffers.get(acpSessionId);
    if (!buffer) {
      return [];
    }
    return buffer.map((b) => b.update);
  }

  /**
   * Appends a wire-shaped update to the ring buffer, evicting oldest events
   * when either the count or aggregate-byte cap is exceeded. Byte
   * accounting tracks the sum of element JSON sizes; the cap is a soft
   * target (off by at most `buffer.length` for delimiters in the eventual
   * `JSON.stringify(buffer)` output).
   */
  private appendToBuffer(
    acpSessionId: string,
    update: AcpSessionUpdateEvent,
  ): void {
    const buffer = this.eventBuffers.get(acpSessionId);
    if (!buffer) {
      return;
    } // Session already torn down.
    const byteSize = Buffer.byteLength(JSON.stringify(update), "utf8");
    buffer.push({ update, byteSize });
    let totalBytes = 0;
    for (const entry of buffer) {
      totalBytes += entry.byteSize;
    }

    while (
      buffer.length > 0 &&
      (buffer.length > MAX_BUFFER_EVENTS || totalBytes > MAX_BUFFER_BYTES)
    ) {
      const dropped = buffer.shift();
      if (dropped !== undefined) {
        totalBytes -= dropped.byteSize;
      }
    }
  }

  /**
   * Persists the session's final state + buffered event log to
   * `acp_session_history`, then frees the buffer entry. Upserts on id:
   * resumed runs reuse the original vellum session id, so their terminal
   * write must update the existing row (status, event log, etc.) instead of
   * being silently skipped. Best-effort: a DB failure is logged but does
   * not propagate, since the session has already reached a terminal state
   * and clients have been notified.
   */
  private persistTerminal(acpSessionId: string, entry: SessionEntry): void {
    const buffer = this.eventBuffers.get(acpSessionId) ?? [];
    // Serialize only the wire-shaped updates — drop the byte-size accounting
    // metadata so persisted rows match the protocol shape clients receive.
    const eventLogJson = JSON.stringify(buffer.map((b) => b.update));
    const usage = entry.state.latestUsage;
    const usageColumns = {
      task: entry.state.task ?? null,
      parentToolUseId: entry.state.parentToolUseId ?? null,
      authErrorCode: entry.state.authErrorCode ?? null,
      authErrorCredential: entry.state.authErrorCredential ?? null,
      usedTokens: usage?.usedTokens ?? null,
      contextSize: usage?.contextSize ?? null,
      costAmount: usage?.costAmount ?? null,
      costCurrency: usage?.costCurrency ?? null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    };
    try {
      getDb()
        .insert(acpSessionHistory)
        .values({
          id: acpSessionId,
          agentId: entry.state.agentId,
          acpSessionId: entry.state.acpSessionId,
          parentConversationId: entry.parentConversationId,
          startedAt: entry.state.startedAt,
          completedAt: entry.state.completedAt ?? null,
          status: entry.state.status,
          stopReason: entry.state.stopReason ?? null,
          error: entry.state.error ?? null,
          eventLogJson,
          cwd: entry.cwd,
          ...usageColumns,
        })
        .onConflictDoUpdate({
          target: acpSessionHistory.id,
          set: {
            status: entry.state.status,
            completedAt: entry.state.completedAt ?? null,
            stopReason: entry.state.stopReason ?? null,
            error: entry.state.error ?? null,
            eventLogJson,
            cwd: entry.cwd,
            ...usageColumns,
          },
        })
        .run();
    } catch (err) {
      log.error(
        { acpSessionId, err },
        "Failed to persist ACP session history row",
      );
    }
    // Drop the buffer entry to free memory regardless of write outcome.
    this.eventBuffers.delete(acpSessionId);
  }

  /**
   * Fires a prompt in the background and wires up completion/error event
   * handlers. Returns the promise so callers can track in-flight state.
   */
  private firePromptInBackground(
    acpSessionId: string,
    entry: SessionEntry,
    acpProtocolSessionId: string,
    message: string,
  ): Promise<unknown> {
    log.info({ acpSessionId, messageLen: message.length }, "ACP firing prompt");
    // Checkpoint stderr before the prompt so a failure derives only from stderr
    // this prompt produced — not lines retained from startup, resume, or an
    // earlier (possibly cancelled) prompt.
    const stderrMark = entry.process.markStderr();
    const promptPromise = entry.process
      .prompt(acpProtocolSessionId, message)
      .then((response) => {
        const current = this.sessions.get(acpSessionId);
        // Only mutate state if the session still exists, this is still the
        // current prompt (not stale from a previous steer), and the status
        // hasn't been set to "cancelled" already.
        if (current && current.currentPrompt === promptPromise) {
          if (current.state.status !== "cancelled") {
            current.state.status = "completed";
            current.state.completedAt = Date.now();
            current.state.stopReason = response.stopReason;
          }
          current.currentPrompt = null;

          // `PromptResponse.usage` carries cumulative input/output totals across
          // all turns. Overwrite (not accumulate) onto the latest usage gauge so
          // the terminal persist captures them, and emit so clients see the final
          // counts. Reuse the most recent context-window snapshot for
          // usedTokens/contextSize, which the prompt response does not report.
          const usage = response.usage;
          if (usage) {
            const prior = current.state.latestUsage;
            current.state.latestUsage = {
              usedTokens: prior?.usedTokens ?? 0,
              contextSize: prior?.contextSize ?? 0,
              costAmount: prior?.costAmount,
              costCurrency: prior?.costCurrency,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            };
            current.sendToVellum({
              type: "acp_session_usage",
              acpSessionId,
              usedTokens: current.state.latestUsage.usedTokens,
              contextSize: current.state.latestUsage.contextSize,
              costAmount: current.state.latestUsage.costAmount,
              costCurrency: current.state.latestUsage.costCurrency,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          }
          log.info(
            { acpSessionId, stopReason: response.stopReason },
            "ACP prompt completed",
          );
          current.sendToVellum({
            type: "acp_session_completed",
            acpSessionId,
            stopReason: response.stopReason,
          });

          // Persist the terminal row + buffered event log before tearing
          // down (teardown deletes the buffer entry).
          this.persistTerminal(acpSessionId, current);

          // Free the session slot, deny any pending permissions, and
          // kill the agent process.
          this.teardownSession(acpSessionId, current);

          // Notify parent session so the LLM sees the agent's output.
          const agentLabel = current.state.agentId;
          const responseText = current.clientHandler.responseText;
          const hint = claudeResumeHint(
            current.command,
            current.cwd,
            current.state.acpSessionId,
          );
          const resumeHint = hint ? `\n\n${hint}` : "";
          // Skip when cancelled: a prompt can win the cancel race by resolving
          // normally, but a user stop must not enqueue a completion and wake the
          // parent (mirrors the failure-path gate below).
          if (current.state.status !== "cancelled") {
            this.notifyParent(
              current,
              `[ACP agent "${agentLabel}" completed]\n\n${responseText}${resumeHint}`,
            );
          }
        }
      })
      .catch(async (err: Error) => {
        const current = this.sessions.get(acpSessionId);
        // Same guards: entry must exist, prompt must be current, and status
        // must not have been set to "cancelled".
        if (current && current.currentPrompt === promptPromise) {
          // The ack message is often a generic "Internal error"; recover the
          // real cause from the adapter's retained stderr.
          const failureMessage = deriveFailureError(
            err.message,
            current.process.stderrSince(stderrMark),
          );
          const errorCode = claudeAuthRequiredCode(
            err,
            failureMessage,
            current,
          );
          if (current.state.status !== "cancelled") {
            current.state.status = "failed";
            current.state.completedAt = Date.now();
            current.state.error = failureMessage;
          }
          current.currentPrompt = null;
          log.error(
            { acpSessionId, error: err.message, failureMessage, errorCode },
            "ACP prompt failed",
          );
          // `acp_session_error` keeps its pre-existing shape so older packaged
          // clients still parse it; the recovery signal rides its own event
          // below (see `api/events/acp-auth-required.ts`).
          current.sendToVellum({
            type: "acp_session_error",
            acpSessionId,
            error: failureMessage,
          });
          // The recovery surface (event, model guidance, prompt-dedup marker)
          // is raised as a unit, and only when a spawning tool call exists to
          // anchor the card AND the user did not already stop the run. A
          // cancelled run renders no card (the client guards it), so marking
          // the never-cleared prompt-dedup registry here would suppress the
          // secure token prompt against a card that never appears.
          const recoveryAnchor =
            errorCode !== undefined && current.state.status !== "cancelled"
              ? current.parentToolUseId
              : undefined;
          // Claude refused this credential, so no later spawn should resolve
          // it again. Recorded before the card is raised and independently of
          // the marker, because the user may delete this run and clearing
          // history must not put the revoked value back in play.
          if (errorCode !== undefined) {
            noteClaudeTokenRefused(current.credentialDigest, Date.now());
          }
          // The live event reaches clients that are listening now, and the
          // card it raises deliberately skips connected-state self-healing, so
          // nothing retires it until the next snapshot. If the credential has
          // already been replaced, that snapshot is the only thing that would
          // have withheld it, and it may be a navigation away. Ask the same
          // question the read path asks, against the same source of truth.
          //
          // An optimisation, not the authority: a write landing right after
          // this read raises a card the next snapshot withholds. The marker is
          // written either way, so the read path still has the final say.
          const stillCurrent =
            errorCode !== undefined &&
            recoveryAnchor !== undefined &&
            acpAuthMarkerStillCurrent(
              current.credentialDigest,
              // Imported at call time so this module's load graph stays as it
              // was: several suites stub `prepare-agent-env` with a partial
              // factory, and a new static import from here would break their
              // module resolution rather than their assertions.
              await import("./prepare-agent-env.js")
                .then((m) =>
                  m.resolvedClaudeCredentialDigest(current.state.agentId),
                )
                // Unknown reads as current, matching the comparison itself:
                // failing toward a card the next snapshot can withdraw beats
                // withholding the user's only route back to auth.
                .catch(() => current.credentialDigest),
            );
          // The credential read above suspends this handler, and a cancel
          // landing in that window runs to completion first: `cancel()`
          // persists the cancelled row, drops the event buffer and tears the
          // session down. Carrying on would emit a card for a run the user
          // stopped and, worse, persist a second time over a buffer that is
          // already gone, replacing the stored event log with an empty one.
          // The map is the evidence: `teardownSession` removes the entry, so an
          // entry that is no longer the registered one means someone else has
          // already finished this session and there is nothing left here to
          // do.
          if (this.sessions.get(acpSessionId) !== current) {
            return;
          }
          if (
            errorCode !== undefined &&
            recoveryAnchor !== undefined &&
            stillCurrent
          ) {
            current.sendToVellum({
              type: "acp_auth_required",
              acpSessionId,
              authCode: errorCode,
              agent: current.state.agentId,
              parentToolUseId: recoveryAnchor,
            });
            // Same registry as the missing-token spawn path, so the
            // credential-prompt route redirects a redundant secure prompt at
            // the card instead of stacking a second one.
            markAcpConnectCardRaised(
              current.parentConversationId,
              current.state.agentId,
            );
            // The event above only reaches clients listening right now. The
            // code goes on the state so `persistTerminal` (called just below)
            // carries it to the history row, which is what a client that
            // reopens the conversation re-raises the card from.
            current.state.authErrorCode = errorCode;
            // Tell clients to re-read the snapshot, which is the only thing
            // that can withdraw this card. The check above reads the vault
            // and then this branch runs, so a replacement completing in
            // between publishes its own invalidation before the event goes
            // out, and a client that acted on it would never look again. This
            // nudge lands after, so whatever the snapshot says wins.
            void import("../runtime/sync/sync-publisher.js")
              .then(({ publishSyncInvalidation }) =>
                publishSyncInvalidation([SYNC_TAGS.acpAuthRecovery]),
              )
              .catch((err: unknown) => {
                log.warn(
                  { err },
                  "failed to publish ACP auth recovery invalidation",
                );
              });
            // Named beside the code so the marker can answer for itself later.
            // Without it the row says auth broke but not on what, and a reader
            // has no way to tell a failure the user has since repaired from one
            // still waiting on them.
            current.state.authErrorCredential = current.credentialDigest;
          }

          // Persist the terminal row before teardown clears the buffer.
          this.persistTerminal(acpSessionId, current);

          // Free the session slot and deny any pending permissions.
          this.teardownSession(acpSessionId, current);

          // Wake the parent with the failure (mirrors the success path) so
          // the assistant reports it instead of silently re-spawning. Skip
          // when cancelled: a user-cancelled run tears down silently and must
          // not inject a turn. teardownSession leaves state intact, so the
          // agentId read below is still valid.
          if (current.state.status !== "cancelled") {
            this.notifyParent(
              current,
              `[ACP agent "${current.state.agentId}" failed]\n\n${failureMessage}` +
                // Same predicate as the recovery surface above. Telling the
                // model a Connect card is waiting when none was raised sends
                // it to an affordance that does not exist.
                (stillCurrent ? `\n\n${ACP_AUTH_RECOVERY_GUIDANCE}` : ""),
            );
          }
        }
      });

    return promptPromise;
  }

  /**
   * Injects an ACP run's outcome into its parent conversation. Shared by the
   * success and failure paths of firePromptInBackground so a hard failure
   * reaches the parent (and its inline card) exactly like a completion does.
   *
   * The message carries `acpNotification` metadata so the daemon skips its
   * user_message_echo and the client filters it from the rendered transcript —
   * the user sees the run through its inline card, not a raw chat turn, while
   * the LLM still receives the text.
   *
   * Reads `entry.state.acpSessionId`/`agentId`, which teardownSession leaves
   * intact, so callers may invoke this after tearing the session down.
   */
  private notifyParent(entry: SessionEntry, message: string): void {
    const acpNotification = {
      acpSessionId: entry.state.acpSessionId,
      agent: entry.state.agentId,
    };
    const parentConversation = findConversation(entry.parentConversationId);
    if (!parentConversation) {
      log.warn(
        { parentConversationId: entry.parentConversationId },
        "ACP agent finished but parent conversation not found",
      );
      return;
    }
    // The notification turn streams to whoever is watching (the parent's sink is
    // its client hub), but it is machine-injected with no human asserted to be
    // present, so it runs non-interactive: a tool that would need approval is
    // denied rather than left waiting on a prompt nobody may answer.
    const enqueueResult = parentConversation.enqueueMessage({
      content: message,
      metadata: { acpNotification },
      isInteractive: false,
    });
    if (enqueueResult.queued || enqueueResult.rejected) {
      return;
    }
    parentConversation
      .persistUserMessage({ content: message, metadata: { acpNotification } })
      .then(({ id: messageId }) =>
        parentConversation.runAgentLoop(message, messageId, {
          isInteractive: false,
        }),
      )
      .catch((err) => {
        log.error(
          { parentConversationId: entry.parentConversationId, err },
          "Failed to process ACP notification in parent",
        );
      });
  }

  /**
   * Kills all processes on shutdown. Also flags the manager as disposed so
   * resumes that are mid-await when shutdown happens abort before spawning
   * a child process nothing would ever kill.
   */
  dispose(): void {
    this.disposed = true;
    this.closeAll();
  }
}

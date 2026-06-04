/**
 * ACP session manager — orchestrates ACP agent process lifecycles with
 * concurrency control, permission resolution, and session state tracking.
 */

import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";

import { findConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AcpSessionUpdate } from "../daemon/message-types/acp.js";
import { getDb } from "../memory/db-connection.js";
import { acpSessionHistory } from "../memory/schema.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import { AcpAgentProcess } from "./agent-process.js";
import { VellumAcpClientHandler } from "./client-handler.js";
import type { AcpAgentConfig, AcpSessionState } from "./types.js";

const log = getLogger("acp:session-manager");

/**
 * Thrown by {@link AcpSessionManager.continueSession} when the resolved target
 * session has a prompt still in flight (`running`/`initializing`). Continuing
 * such a session would route through `steer()`'s cancel-on-running path and
 * abort the in-progress task, so the manager rejects it and lets callers
 * translate to their wire format (tool → isError, route → 409). Distinct from
 * the generic not-found `Error` so callers can map it to the right status.
 */
export class SessionBusyError extends Error {
  readonly acpSessionId: string;
  readonly sessionStatus: "running" | "initializing";

  constructor(acpSessionId: string, status: "running" | "initializing") {
    super(
      `ACP session "${acpSessionId}" is busy (${status}); wait for the ` +
        "current task to finish before continuing.",
    );
    this.name = "SessionBusyError";
    this.acpSessionId = acpSessionId;
    this.sessionStatus = status;
  }
}

/**
 * Thrown by {@link AcpSessionManager.continueSession} when the continue target
 * cannot be resolved — an unknown/closed explicit id, or no live session for
 * the conversation. Distinct from {@link SessionBusyError} so callers map it to
 * not-found (tool → isError, route → 404) rather than busy.
 */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

/** Maximum number of update events kept in a session's ring buffer. */
const MAX_BUFFER_EVENTS = 200;
/** Maximum aggregate JSON size of a session's ring buffer, in bytes. */
const MAX_BUFFER_BYTES = 256 * 1024;
/**
 * Default idle timeout, used when the manager is constructed without one
 * (e.g. tests). The production value comes from `acp.idleTimeoutMs`.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

interface BufferedAcpUpdate {
  /** The wire-shaped update — exactly what was forwarded to clients. */
  update: AcpSessionUpdate;
  /** Cached UTF-8 byte length of `JSON.stringify(update)` for cap math. */
  byteSize: number;
}

interface SessionEntry {
  process: AcpAgentProcess;
  state: AcpSessionState;
  clientHandler: VellumAcpClientHandler;
  /** Wrapped sender that also appends to the ring buffer. */
  sendToVellum: (msg: ServerMessage) => void;
  currentPrompt: Promise<unknown> | null;
  parentConversationId: string;
  cwd: string;
  /** The adapter binary that was spawned. Used to gate resume hints to
   *  the only adapter (claude-agent-acp) whose CLI accepts `--resume`. */
  command: string;
  /**
   * Timer that reclaims this session once it has sat `idle` (process alive,
   * no in-flight prompt) past the configured idle timeout. Armed when a
   * prompt completes and the session transitions to `idle`; cleared when a
   * follow-up prompt starts or the session is torn down.
   */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Timestamp (epoch ms) of the session's most recent activity boundary —
   * stamped whenever the session transitions to `idle` (a prompt completed)
   * and refreshed on every `steer()` reuse. Unlike `state.startedAt` (set once
   * at creation, never updated), this reflects *recency of use*, so the idle
   * eviction picker can reap the session that has actually sat idle the
   * longest instead of the one with the oldest start time.
   */
  lastActiveAt: number;
  /**
   * Whether a terminal `acp_session_history` row has already been written
   * for this session's last completed task. Set when a prompt completes and
   * the session goes idle (the row reflects that completed task). Prevents a
   * later close/idle-reap from re-persisting and clobbering the durable
   * outcome with a `cancelled` status.
   */
  historyPersisted: boolean;
  /**
   * Zero-based index of the current prompt turn. The session and its ACP
   * protocol id are reused across turns when an idle session is steered, but
   * each turn must get its own `acp_session_history` row — otherwise the
   * `id`-keyed insert silently no-ops (`onConflictDoNothing`) on the second
   * turn and drops its event log / stop reason. `historyRowId()` derives a
   * per-turn primary key from this; turn 0 keeps the bare `acpSessionId` so
   * the first turn's row id (and all existing behavior) is unchanged.
   */
  turnIndex: number;
}

export class AcpSessionManager {
  private sessions = new Map<string, SessionEntry>();
  /**
   * Per-session ring buffer of wire-shaped update events forwarded to
   * clients. Bounded by event count and aggregate JSON byte size; oldest
   * events are dropped first when caps are exceeded. Persisted to
   * `acp_session_history` on terminal transition, then cleared.
   */
  private eventBuffers = new Map<string, BufferedAcpUpdate[]>();

  private readonly idleTimeoutMs: number;

  constructor(
    private readonly maxConcurrent: number,
    idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {
    this.idleTimeoutMs = idleTimeoutMs;
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
    sendToVellum: (msg: ServerMessage) => void,
  ): Promise<{ acpSessionId: string; protocolSessionId: string }> {
    if (this.sessions.size >= this.maxConcurrent) {
      // Completed sessions linger as `idle` (process alive) for follow-up
      // reuse, but a few of them would otherwise occupy the whole concurrency
      // budget and block all new spawns until the idle timeout fires — even
      // with zero prompts in flight. Reclaim the oldest idle session to free a
      // slot before rejecting. Its completed task already wrote a terminal
      // history row, so close() tears it down without re-persisting; this also
      // bounds the number of resident adapter processes. Only reject when every
      // tracked session is genuinely running/initializing.
      const oldestIdle = this.oldestIdleSession();
      if (oldestIdle) {
        log.info(
          { reapedAcpSessionId: oldestIdle, maxConcurrent: this.maxConcurrent },
          "Reaping oldest idle ACP session to free a spawn slot",
        );
        this.close(oldestIdle);
      } else {
        throw new Error(
          `ACP concurrency limit reached (max ${this.maxConcurrent}). ` +
            `Close an existing session before spawning a new one.`,
        );
      }
    }

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

    // Initialize the per-session ring buffer before any update can fire.
    this.eventBuffers.set(acpSessionId, []);

    // Wrap the sender so every emitted message is mirrored into the buffer
    // when it's an `acp_session_update`. The wrapper preserves the original
    // call semantics — it forwards every message unchanged.
    const wrappedSend = (msg: ServerMessage) => {
      if (msg.type === "acp_session_update") {
        this.appendToBuffer(acpSessionId, msg);
      }
      sendToVellum(msg);
    };

    const clientHandler = new VellumAcpClientHandler(
      acpSessionId,
      wrappedSend,
      parentConversationId,
      // Hand the handler the agent's own injected credentials (the same
      // `config.env` the adapter process is spawned with) so terminals it
      // launches via createTerminal get the agent's git/LLM auth without
      // inheriting the daemon environment.
      agentConfig.env,
    );

    const agentProcess = new AcpAgentProcess(
      agentId,
      agentConfig,
      (_agent) => clientHandler,
    );

    // Reserve a slot in the map before any async work to enforce the
    // concurrency limit even when multiple spawn() calls race.
    const state: AcpSessionState = {
      id: acpSessionId,
      agentId,
      acpSessionId: "", // placeholder until createSession resolves
      parentConversationId,
      status: "initializing",
      startedAt: Date.now(),
    };

    const entry: SessionEntry = {
      process: agentProcess,
      state,
      clientHandler,
      sendToVellum: wrappedSend,
      currentPrompt: null,
      parentConversationId,
      cwd,
      command: agentConfig.command,
      idleTimer: null,
      lastActiveAt: Date.now(),
      historyPersisted: false,
      turnIndex: 0,
    };

    this.sessions.set(acpSessionId, entry);

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
      // Kill the orphaned child process and remove the reserved slot.
      agentProcess.kill();
      this.sessions.delete(acpSessionId);
      this.eventBuffers.delete(acpSessionId);
      throw err;
    }

    wrappedSend({
      type: "acp_session_spawned",
      acpSessionId,
      agent: agentId,
      parentConversationId,
    });

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
   * Sends a follow-up instruction to an existing session.
   *
   * Works against a `running` session (cancels its in-flight prompt first)
   * or an `idle` session left alive after a previous prompt completed — the
   * latter is the multi-turn continuity path: the adapter process and ACP
   * session are reused so the follow-up builds on the same context.
   *
   * Cancels any in-flight prompt first, then fires the new prompt in the
   * background with completion/error event handlers (matching spawn's pattern).
   */
  async steer(acpSessionId: string, instruction: string): Promise<void> {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(`ACP session "${acpSessionId}" not found`);
    }

    if (entry.state.status !== "running" && entry.state.status !== "idle") {
      throw new Error(
        `ACP session "${acpSessionId}" is not reusable (status: ${entry.state.status})`,
      );
    }

    // Reuse of an `idle` session is the case clients can't infer from the
    // event stream: they already show it as completed/idle, and steering only
    // appends `acp_session_update` events. A genuinely `running` session is
    // already shown as running, so it needs no resume signal.
    const wasIdle = entry.state.status === "idle";

    // Disarm the idle reaper — the session is being reused.
    this.clearIdleTimer(entry);
    // Mark the session freshly active so a just-reused session is treated as
    // recently active (not stale) by the idle eviction picker.
    entry.lastActiveAt = Date.now();

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

    // Reset per-turn streaming state so this follow-up's events are buffered
    // and (on completion) persisted fresh, not appended to the prior task's
    // already-persisted log.
    entry.clientHandler.resetTurn();
    this.eventBuffers.set(acpSessionId, []);
    entry.historyPersisted = false;
    // Advance the turn so this reused turn persists to its own history row
    // instead of no-op-conflicting against the prior turn's row.
    entry.turnIndex += 1;
    entry.state.status = "running";
    entry.state.completedAt = undefined;
    entry.state.stopReason = undefined;
    entry.state.error = undefined;

    // Tell clients an existing (idle) session is running again. The spawn path
    // emits `acp_session_spawned` to CREATE a session; reuse instead flips a
    // session clients already track from completed/idle back to running, so it
    // stops looking finished while this follow-up turn runs.
    if (wasIdle) {
      entry.sendToVellum({ type: "acp_session_resumed", acpSessionId });
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
   * Single source of truth for the `acp_continue` flow (used by both the
   * `acp_continue` tool and the `POST /v1/acp/continue` route): resolve the
   * target session, refuse one whose prompt is still in flight, and otherwise
   * steer a follow-up turn onto it.
   *
   * Targeting resolves an explicit `acpSessionId` (via `getStatus`) when given,
   * otherwise the conversation's most-recent live session (via
   * `getLiveSessionForConversation`).
   *
   * Rejection semantics — distinct from `steer()`, whose cancel-on-running
   * behavior `acp_steer` deliberately keeps:
   *  - {@link SessionNotFoundError}: unknown/closed explicit id, or no live
   *    session for the conversation, or a steer that rejects (adapter torn down
   *    between the status read and the steer).
   *  - {@link SessionBusyError}: the resolved session is `running`/
   *    `initializing` — continuing it would abort the in-flight task.
   *
   * Returns the resolved `acpSessionId` on success so callers can echo it.
   */
  async continueSession(opts: {
    acpSessionId?: string;
    parentConversationId?: string;
    instruction: string;
  }): Promise<{ acpSessionId: string }> {
    let acpSessionId = opts.acpSessionId;
    let status: AcpSessionState["status"] | undefined;

    if (acpSessionId) {
      let state: AcpSessionState | AcpSessionState[];
      try {
        state = this.getStatus(acpSessionId);
      } catch {
        throw new SessionNotFoundError(
          `ACP session "${acpSessionId}" not found or not reusable.`,
        );
      }
      if (!Array.isArray(state)) status = state.status;
    } else if (opts.parentConversationId) {
      const live = this.getLiveSessionForConversation(
        opts.parentConversationId,
      );
      if (!live) {
        throw new SessionNotFoundError(
          "No live ACP session to continue for this conversation.",
        );
      }
      acpSessionId = live.id;
      status = live.status;
    } else {
      throw new SessionNotFoundError(
        "No live ACP session to continue for this conversation.",
      );
    }

    // A prompt is still in flight: steering would CANCEL it, aborting the
    // in-progress task. Refuse cleanly and let the caller wait.
    if (status === "running" || status === "initializing") {
      throw new SessionBusyError(acpSessionId!, status);
    }

    try {
      await this.steer(acpSessionId!, opts.instruction);
    } catch (err) {
      throw new SessionNotFoundError(
        err instanceof Error ? err.message : String(err),
      );
    }

    return { acpSessionId: acpSessionId! };
  }

  /**
   * Returns the live (non-terminal: running or idle) session attached to a
   * conversation, if any. Used to reattach a follow-up prompt to an existing
   * session for multi-turn continuity (PR E2). Returns the most recently
   * *active* match when several are live for the same conversation.
   *
   * Ordered by `lastActiveAt` (refreshed on every `steer()` reuse), not
   * `state.startedAt` (set once at creation). A just-reused session must win
   * "most recent" over a session that merely *started* later — otherwise
   * continue-by-conversation could keep routing to a newer-started session
   * instead of the one the user actually used last.
   */
  getLiveSessionForConversation(
    parentConversationId: string,
  ): AcpSessionState | null {
    let best: SessionEntry | null = null;
    for (const entry of this.sessions.values()) {
      if (entry.parentConversationId !== parentConversationId) continue;
      if (entry.state.status !== "running" && entry.state.status !== "idle") {
        continue;
      }
      if (!best || entry.lastActiveAt > best.lastActiveAt) {
        best = entry;
      }
    }
    return best?.state ?? null;
  }

  /**
   * Returns the acpSessionId of the `idle` session that has sat idle the
   * LONGEST (smallest `lastActiveAt`), or null if none are idle. Used to free a
   * concurrency slot when a new spawn hits the limit: idle sessions have no
   * in-flight prompt, so reaping the least-recently-active one is the
   * least-disruptive way to make room. Keyed on `lastActiveAt` (refreshed on
   * every steer reuse) rather than `state.startedAt` (set once at creation), so
   * a just-reused session is not reaped before one that has actually been idle
   * far longer.
   */
  private oldestIdleSession(): string | null {
    let bestId: string | null = null;
    let bestActiveAt = Infinity;
    for (const [id, entry] of this.sessions) {
      if (entry.state.status !== "idle") continue;
      if (entry.lastActiveAt < bestActiveAt) {
        bestActiveAt = entry.lastActiveAt;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * Cancels an ongoing prompt in the specified session.
   *
   * The session's in-flight `prompt()` will reject in response, and the
   * catch handler in `firePromptInBackground` performs the terminal
   * persistence + teardown. We just flip the status here so that handler
   * preserves "cancelled" instead of overwriting with "failed".
   */
  async cancel(acpSessionId: string): Promise<void> {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(`ACP session "${acpSessionId}" not found`);
    }

    // An `idle` session has no in-flight prompt, so there is no catch handler
    // to persist + tear it down. Cancelling it must therefore drive the
    // close/teardown path directly — otherwise the adapter process, idle
    // timer, and session-map entry leak until the daemon restarts. Its
    // completed task already wrote a terminal history row, so `close()` skips
    // re-persisting (and won't clobber the durable `completed` row).
    if (entry.state.status === "idle") {
      await entry.process.cancel(entry.state.acpSessionId).catch((err) => {
        log.warn(
          { acpSessionId, err },
          "Failed to send ACP cancel before tearing down idle session",
        );
      });
      this.close(acpSessionId);
      return;
    }

    await entry.process.cancel(entry.state.acpSessionId);
    entry.state.status = "cancelled";
    entry.state.completedAt = Date.now();
  }

  /**
   * Kills the agent process and removes the session from tracking.
   *
   * Persists the buffered event log first so abort paths
   * (`executeAcpAbort`, daemon shutdown) don't drop history. If the
   * session is still in a non-terminal state, mark it cancelled so the
   * persisted row reflects reality. The in-flight prompt's then/catch
   * handler will short-circuit after teardown removes the entry.
   *
   * An `idle` session is a special case: its last task already wrote a
   * terminal `completed` row, so we skip re-persisting (which would only
   * be a no-op `onConflictDoNothing`) and just tear down the live process.
   */
  close(acpSessionId: string): void {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(`ACP session "${acpSessionId}" not found`);
    }
    if (
      entry.state.status === "running" ||
      entry.state.status === "initializing"
    ) {
      entry.state.status = "cancelled";
      entry.state.completedAt = Date.now();
    }
    // Skip re-persisting when the idle session's completed task was already
    // written to history; otherwise persist the buffered log + terminal row.
    if (!entry.historyPersisted) {
      this.persistTerminal(acpSessionId, entry);
    }
    this.teardownSession(acpSessionId, entry);
  }

  /**
   * Denies pending ACP permissions, kills the process, and removes the session.
   */
  private teardownSession(acpSessionId: string, entry: SessionEntry): void {
    this.clearIdleTimer(entry);
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
   * Arms the idle-timeout reaper for a session that just went `idle`. When it
   * fires the session is closed (process killed, slot freed) unless a
   * follow-up prompt reused it first. `unref()` so the timer never keeps the
   * process alive on shutdown.
   */
  private armIdleTimer(acpSessionId: string, entry: SessionEntry): void {
    this.clearIdleTimer(entry);
    const timer = setTimeout(() => {
      const current = this.sessions.get(acpSessionId);
      // Only reap if it's still the same idle session (not reused/closed).
      if (!current || current !== entry || current.state.status !== "idle") {
        return;
      }
      log.info(
        { acpSessionId, idleTimeoutMs: this.idleTimeoutMs },
        "Reclaiming idle ACP session after timeout",
      );
      // History was already persisted on completion; close() tears down
      // without re-persisting.
      this.close(acpSessionId);
    }, this.idleTimeoutMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  /** Clears a session's idle-timeout reaper if one is armed. */
  private clearIdleTimer(entry: SessionEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
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
        throw new Error(`ACP session "${acpSessionId}" not found`);
      }
      return entry.state;
    }
    return Array.from(this.sessions.values()).map((e) => e.state);
  }

  /**
   * Appends a wire-shaped update to the ring buffer, evicting oldest events
   * when either the count or aggregate-byte cap is exceeded. Byte
   * accounting tracks the sum of element JSON sizes; the cap is a soft
   * target (off by at most `buffer.length` for delimiters in the eventual
   * `JSON.stringify(buffer)` output).
   */
  private appendToBuffer(acpSessionId: string, update: AcpSessionUpdate): void {
    const buffer = this.eventBuffers.get(acpSessionId);
    if (!buffer) return; // Session already torn down.
    const byteSize = Buffer.byteLength(JSON.stringify(update), "utf8");
    buffer.push({ update, byteSize });
    let totalBytes = 0;
    for (const entry of buffer) totalBytes += entry.byteSize;

    while (
      buffer.length > 0 &&
      (buffer.length > MAX_BUFFER_EVENTS || totalBytes > MAX_BUFFER_BYTES)
    ) {
      const dropped = buffer.shift();
      if (dropped !== undefined) totalBytes -= dropped.byteSize;
    }
  }

  /**
   * Derives the `acp_session_history` primary key for a given turn. Turn 0
   * (the spawn prompt) keeps the bare `acpSessionId` so first-turn rows — and
   * the in-memory→DB id merge in the sessions list — are unchanged. Reused
   * turns (via `steer()` on an idle session) get a `<acpSessionId>:<turn>`
   * suffix so each turn persists to its own row instead of silently
   * conflicting against the first turn's already-written row.
   */
  private historyRowId(acpSessionId: string, turnIndex: number): string {
    // First turn (turnIndex 0, or unset on manually-built entries) keeps the
    // bare session id; only reused turns get a `:<n>` suffix.
    return turnIndex ? `${acpSessionId}:${turnIndex}` : acpSessionId;
  }

  /**
   * Persists the session's final state + buffered event log to
   * `acp_session_history`, then frees the buffer entry. Best-effort: a DB
   * failure is logged but does not propagate, since the session has already
   * reached a terminal state and clients have been notified.
   */
  private persistTerminal(acpSessionId: string, entry: SessionEntry): void {
    const buffer = this.eventBuffers.get(acpSessionId) ?? [];
    // Serialize only the wire-shaped updates — drop the byte-size accounting
    // metadata so persisted rows match the protocol shape clients receive.
    const wireUpdates = buffer.map((buffered) => buffered.update);
    // Turn 0 keeps the original spawn time. Reused turns (steer on an idle
    // session) ran later than the original `startedAt`, so persist the turn's
    // own start time (`lastActiveAt`, which `steer()` stamps to the turn
    // start) — otherwise every later turn's row would carry the stale spawn
    // timestamp and sort behind a session that merely started later in the
    // `/acp/sessions` ordering.
    const rowStartedAt =
      entry.turnIndex > 0 ? entry.lastActiveAt : entry.state.startedAt;
    try {
      getDb()
        .insert(acpSessionHistory)
        .values({
          id: this.historyRowId(acpSessionId, entry.turnIndex),
          agentId: entry.state.agentId,
          acpSessionId: entry.state.acpSessionId,
          parentConversationId: entry.parentConversationId,
          startedAt: rowStartedAt,
          completedAt: entry.state.completedAt ?? null,
          status: entry.state.status,
          stopReason: entry.state.stopReason ?? null,
          error: entry.state.error ?? null,
          eventLogJson: JSON.stringify(wireUpdates),
        })
        .onConflictDoNothing()
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
    const promptPromise = entry.process
      .prompt(acpProtocolSessionId, message)
      .then((response) => {
        const current = this.sessions.get(acpSessionId);
        // Only act if the session still exists and this is still the current
        // prompt (not stale from a previous steer); teardown removes the entry,
        // so a concurrent abort path won't re-run this handler.
        if (current && current.currentPrompt === promptPromise) {
          // The prompt counts as cancelled if either a concurrent
          // cancel()/close() already flipped the status to `cancelled`, or the
          // adapter resolved with a `cancelled` stop reason — the latter can
          // win the race before cancel() sets the status, so checking only the
          // status would mis-persist a cancelled prompt as `completed` and
          // wrongly keep the session alive as a reusable `idle`. Either way the
          // prompt was aborted: persist a cancelled row and tear down. A clean
          // completion instead keeps the session alive as `idle` so a follow-up
          // prompt can reuse the same process and context.
          const wasCancelled =
            current.state.status === "cancelled" ||
            response.stopReason === "cancelled";
          current.currentPrompt = null;
          log.info(
            { acpSessionId, stopReason: response.stopReason },
            "ACP prompt completed",
          );
          current.sendToVellum({
            type: "acp_session_completed",
            acpSessionId,
            stopReason: response.stopReason,
          });

          if (wasCancelled) {
            // Mark the state cancelled (idempotent if cancel() already did) so
            // the persisted row reflects the cancellation even when the
            // stopReason-race beat cancel() to it. Match how cancel() records a
            // cancelled terminal row (status + completedAt), plus the
            // stopReason the adapter reported.
            current.state.status = "cancelled";
            current.state.completedAt ??= Date.now();
            current.state.stopReason = response.stopReason;
            // Persist the cancelled terminal row + buffered event log, then
            // tear the session down (cancel is not a reuse path).
            this.persistTerminal(acpSessionId, current);
            this.teardownSession(acpSessionId, current);
          } else {
            current.state.completedAt = Date.now();
            current.state.stopReason = response.stopReason;
            // Persist the completed task to history (the durable record),
            // then transition to `idle` and arm the reaper. The process and
            // ACP session stay alive for a follow-up `steer()`.
            current.state.status = "completed";
            this.persistTerminal(acpSessionId, current);
            current.historyPersisted = true;
            current.state.status = "idle";
            // Stamp the idle boundary so eviction reaps the longest-idle
            // session, not the one with the oldest start time.
            current.lastActiveAt = Date.now();
            this.armIdleTimer(acpSessionId, current);
          }

          // Notify parent session so the LLM sees the agent's output
          const agentLabel = current.state.agentId;
          const responseText = current.clientHandler.responseText;
          const sessionId = current.state.acpSessionId;
          const resumeHint =
            current.command === "claude-agent-acp"
              ? `\n\nTo resume: cd ${current.cwd} && claude --resume ${sessionId}`
              : "";
          const notifyMessage = `[ACP agent "${agentLabel}" completed]\n\n${responseText}${resumeHint}`;
          const parentConversation = findConversation(
            current.parentConversationId,
          );
          if (parentConversation) {
            const enqueueResult = parentConversation.enqueueMessage({
              content: notifyMessage,
            });
            if (!enqueueResult.queued && !enqueueResult.rejected) {
              parentConversation
                .persistUserMessage({ content: notifyMessage })
                .then(({ id: messageId }) =>
                  parentConversation.runAgentLoop(notifyMessage, messageId),
                )
                .catch((err) => {
                  log.error(
                    {
                      parentConversationId: current.parentConversationId,
                      err,
                    },
                    "Failed to process ACP notification in parent",
                  );
                });
            }
          } else {
            log.warn(
              { parentConversationId: current.parentConversationId },
              "ACP agent finished but parent conversation not found",
            );
          }
        }
      })
      .catch((err: Error) => {
        const current = this.sessions.get(acpSessionId);
        // Same guards: entry must exist, prompt must be current, and status
        // must not have been set to "cancelled".
        if (current && current.currentPrompt === promptPromise) {
          if (current.state.status !== "cancelled") {
            current.state.status = "failed";
            current.state.completedAt = Date.now();
            current.state.error = err.message;
          }
          current.currentPrompt = null;
          log.error({ acpSessionId, error: err.message }, "ACP prompt failed");
          current.sendToVellum({
            type: "acp_session_error",
            acpSessionId,
            error: err.message,
          });

          // Persist the terminal row before teardown clears the buffer.
          this.persistTerminal(acpSessionId, current);

          // Free the session slot and deny any pending permissions.
          this.teardownSession(acpSessionId, current);
        }
      });

    return promptPromise;
  }

  /**
   * Kills all processes on shutdown.
   */
  dispose(): void {
    this.closeAll();
  }
}

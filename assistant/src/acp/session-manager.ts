/**
 * ACP session manager — orchestrates ACP agent process lifecycles with
 * concurrency control, permission resolution, and session state tracking.
 */

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { findConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AcpSessionUpdate } from "../daemon/message-types/acp.js";
import { getDb } from "../memory/db-connection.js";
import { acpSessionHistory } from "../memory/schema.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import { AcpAgentProcess } from "./agent-process.js";
import { VellumAcpClientHandler } from "./client-handler.js";
import { prepareAgentEnv } from "./prepare-agent-env.js";
import { resolveAcpAgent } from "./resolve-agent.js";
import type { AcpAgentConfig, AcpSessionState } from "./types.js";

const log = getLogger("acp:session-manager");

/** Single source of truth for the "unknown session id" error message. */
function sessionNotFoundMessage(acpSessionId: string): string {
  return `ACP session "${acpSessionId}" not found`;
}

/**
 * Whether `err` is the manager's "unknown session id" error for
 * `acpSessionId`. Callers (acp_steer tool, /v1/acp/:id/steer route) use this
 * to decide when a failed steer should fall back to resumeFromHistory.
 */
export function isAcpSessionNotFoundError(
  err: unknown,
  acpSessionId: string,
): boolean {
  return (
    err instanceof Error && err.message === sessionNotFoundMessage(acpSessionId)
  );
}

/** Maximum number of update events kept in a session's ring buffer. */
const MAX_BUFFER_EVENTS = 200;
/** Maximum aggregate JSON size of a session's ring buffer, in bytes. */
const MAX_BUFFER_BYTES = 256 * 1024;

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
      throw new Error(
        `ACP concurrency limit reached (max ${this.maxConcurrent}). ` +
          `Close an existing session before spawning a new one.`,
      );
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

    const entry = this.registerSession({
      acpSessionId,
      agentId,
      agentConfig,
      parentConversationId,
      cwd,
      startedAt: Date.now(),
      sendToVellum,
    });
    const { process: agentProcess, state, sendToVellum: wrappedSend } = entry;

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
    sendToVellum: (msg: ServerMessage) => void;
  }): SessionEntry {
    const { acpSessionId } = opts;

    // Initialize the per-session ring buffer before any update can fire.
    this.eventBuffers.set(acpSessionId, []);

    // Wrap the sender so every emitted message is mirrored into the buffer
    // when it's an `acp_session_update`. The wrapper preserves the original
    // call semantics: it forwards every message unchanged.
    const wrappedSend = (msg: ServerMessage) => {
      if (msg.type === "acp_session_update") {
        this.appendToBuffer(acpSessionId, msg);
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
    };

    const entry: SessionEntry = {
      process: agentProcess,
      state,
      clientHandler,
      sendToVellum: wrappedSend,
      currentPrompt: null,
      parentConversationId: opts.parentConversationId,
      cwd: opts.cwd,
      command: opts.agentConfig.command,
    };

    this.sessions.set(acpSessionId, entry);
    return entry;
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
   * before resume support (no cwd), the agent cannot be resolved, or the
   * agent advertises neither resume capability.
   */
  async resumeFromHistory(
    acpSessionId: string,
    sendToVellum: (msg: ServerMessage) => void,
  ): Promise<void> {
    if (this.sessions.has(acpSessionId)) {
      throw new Error(`ACP session "${acpSessionId}" is already active`);
    }
    if (this.sessions.size >= this.maxConcurrent) {
      throw new Error(
        `ACP concurrency limit reached (max ${this.maxConcurrent}). ` +
          `Close an existing session before spawning a new one.`,
      );
    }

    const row = getDb()
      .select()
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, acpSessionId))
      .get();
    if (!row) {
      throw new Error(sessionNotFoundMessage(acpSessionId));
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

    const resolved = resolveAcpAgent(row.agentId);
    if (!resolved.ok) {
      switch (resolved.reason) {
        case "acp_disabled":
          throw new Error(resolved.hint);
        case "unknown_agent":
          throw new Error(
            `Unknown agent "${row.agentId}". Available: ${resolved.available.join(", ")}.`,
          );
        case "binary_not_found":
          throw new Error(
            `${resolved.command} is not on PATH. ${resolved.hint}`,
          );
        default: {
          const _exhaustive: never = resolved;
          throw new Error(
            `Unexpected acp resolver reason: ${(_exhaustive as { reason: string }).reason}`,
          );
        }
      }
    }
    const agentConfig = await prepareAgentEnv(resolved.agent);

    log.info(
      { acpSessionId, agentId: row.agentId, cwd: row.cwd },
      "ACP resume from history requested",
    );

    const entry = this.registerSession({
      acpSessionId,
      agentId: row.agentId,
      agentConfig,
      parentConversationId: row.parentConversationId,
      cwd: row.cwd,
      startedAt: row.startedAt,
      sendToVellum,
    });
    const { process: agentProcess, state, sendToVellum: wrappedSend } = entry;

    // Re-seed the ring buffer from the persisted event log, routed through
    // appendToBuffer so the count/byte caps still apply. The terminal
    // upsert then persists the merged (old + new) log.
    try {
      const persisted = JSON.parse(row.eventLogJson) as unknown;
      if (Array.isArray(persisted)) {
        for (const update of persisted) {
          this.appendToBuffer(acpSessionId, update as AcpSessionUpdate);
        }
      }
    } catch (err) {
      log.warn(
        { acpSessionId, err },
        "Failed to re-seed ACP event buffer from persisted history",
      );
    }

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
      // Kill the orphaned child process and remove the reserved slot.
      agentProcess.kill();
      this.sessions.delete(acpSessionId);
      this.eventBuffers.delete(acpSessionId);
      throw err;
    }

    // Reuse the existing spawned event so connected clients render the
    // session. A dedicated acp_session_resumed event is a possible
    // follow-up, not in scope here.
    wrappedSend({
      type: "acp_session_spawned",
      acpSessionId,
      agent: row.agentId,
      parentConversationId: row.parentConversationId,
    });
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
      throw new Error(sessionNotFoundMessage(acpSessionId));
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
      throw new Error(sessionNotFoundMessage(acpSessionId));
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
   */
  close(acpSessionId: string): void {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(sessionNotFoundMessage(acpSessionId));
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
        throw new Error(sessionNotFoundMessage(acpSessionId));
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

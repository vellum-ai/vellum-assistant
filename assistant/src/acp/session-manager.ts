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
   * Cancels any in-flight prompt first, then fires the new prompt in the
   * background with completion/error event handlers (matching spawn's pattern).
   */
  async steer(acpSessionId: string, instruction: string): Promise<void> {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(`ACP session "${acpSessionId}" not found`);
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
      throw new Error(`ACP session "${acpSessionId}" not found`);
    }
    await entry.process.cancel(entry.state.acpSessionId);
    entry.state.status = "cancelled";
    entry.state.completedAt = Date.now();
  }

  /**
   * Kills the agent process and removes the session from tracking.
   */
  close(acpSessionId: string): void {
    const entry = this.sessions.get(acpSessionId);
    if (!entry) {
      throw new Error(`ACP session "${acpSessionId}" not found`);
    }
    this.teardownSession(acpSessionId, entry);
  }

  /**
   * Denies pending ACP permissions, kills the process, and removes the session.
   */
  private teardownSession(acpSessionId: string, entry: SessionEntry): void {
    for (const requestId of entry.clientHandler.pendingRequestIds) {
      const interaction = pendingInteractions.resolve(requestId);
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
            const enqueueResult = parentConversation.enqueueMessage(
              notifyMessage,
              [],
            );
            if (!enqueueResult.queued && !enqueueResult.rejected) {
              parentConversation
                .persistUserMessage(notifyMessage, [])
                .then((messageId) =>
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

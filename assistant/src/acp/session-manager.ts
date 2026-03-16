/**
 * ACP session manager — orchestrates ACP agent process lifecycles with
 * concurrency control, permission resolution, and session state tracking.
 */

import { randomUUID } from "node:crypto";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";
import { AcpAgentProcess } from "./agent-process.js";
import { resolvePermission, VellumAcpClientHandler } from "./client-handler.js";
import type { AcpAgentConfig, AcpSessionState } from "./types.js";

const log = getLogger("acp:session-manager");

interface SessionEntry {
  process: AcpAgentProcess;
  state: AcpSessionState;
  clientHandler: VellumAcpClientHandler;
  pendingPermissions: Map<string, { resolve: (optionId: string) => void }>;
  sendToVellum: (msg: ServerMessage) => void;
  currentPrompt: Promise<unknown> | null;
  parentSessionId: string;
}

export class AcpSessionManager {
  private sessions = new Map<string, SessionEntry>();

  /**
   * Optional callback to inject a completion/failure message into the parent
   * session's conversation so the LLM sees the agent's output.
   * Wired by DaemonServer at startup.
   */
  onAcpSessionFinished:
    | ((
        parentSessionId: string,
        message: string,
        sendToClient: (msg: ServerMessage) => void,
      ) => Promise<void>)
    | null = null;

  constructor(private readonly maxConcurrent: number) {}

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
    parentSessionId: string,
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
      { acpSessionId, agentId, task: task.slice(0, 200), cwd, parentSessionId },
      "ACP spawn requested",
    );

    const pendingPermissions = new Map<
      string,
      { resolve: (optionId: string) => void }
    >();

    const clientHandler = new VellumAcpClientHandler(
      acpSessionId,
      sendToVellum,
      pendingPermissions,
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
      status: "initializing",
      startedAt: Date.now(),
    };

    const entry: SessionEntry = {
      process: agentProcess,
      state,
      clientHandler,
      pendingPermissions,
      sendToVellum,
      currentPrompt: null,
      parentSessionId,
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
      throw err;
    }

    sendToVellum({
      type: "acp_session_spawned",
      acpSessionId,
      agent: agentId,
      parentSessionId,
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

    // Cancel any in-flight prompt before starting a new one
    if (entry.currentPrompt) {
      try {
        await entry.process.cancel(entry.state.acpSessionId);
      } catch (err) {
        log.warn(
          { acpSessionId, err },
          "Failed to cancel in-flight prompt before steer",
        );
      }
      entry.currentPrompt = null;
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
    entry.process.kill();
    this.sessions.delete(acpSessionId);
  }

  /**
   * Kills all agent processes and clears the session map.
   */
  closeAll(): void {
    for (const entry of this.sessions.values()) {
      entry.process.kill();
    }
    this.sessions.clear();
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
   * Resolves a pending permission request in any session that holds it.
   */
  resolvePermission(requestId: string, optionId: string): void {
    for (const entry of this.sessions.values()) {
      if (entry.pendingPermissions.has(requestId)) {
        resolvePermission(entry.pendingPermissions, requestId, optionId);
        return;
      }
    }
    log.warn({ requestId }, "No pending permission found for request ID");
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

          // Notify parent session so the LLM sees the agent's output
          if (this.onAcpSessionFinished) {
            const agentLabel = current.state.agentId;
            const responseText = current.clientHandler.responseText;
            const notifyMessage = `[ACP agent "${agentLabel}" completed]\n\n${responseText}`;
            this.onAcpSessionFinished(
              current.parentSessionId,
              notifyMessage,
              current.sendToVellum,
            ).catch((notifyErr) => {
              log.error(
                { acpSessionId, notifyErr },
                "Failed to notify parent of ACP completion",
              );
            });
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

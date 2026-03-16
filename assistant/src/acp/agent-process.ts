/**
 * ACP agent process manager.
 *
 * Wraps a child process running an ACP-compliant agent, managing its lifecycle
 * and providing typed methods for the ACP client-side protocol operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type {
  Agent,
  Client,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";

import { getLogger } from "../util/logger.js";
import type { AcpAgentConfig } from "./types.js";

const log = getLogger("acp");

/**
 * Factory function type for creating ACP client handlers.
 * PR 5 will provide the real VellumAcpClientHandler implementation.
 */
export type AcpClientFactory = (agent: Agent) => Client;

/**
 * Manages an ACP agent child process and its protocol connection.
 */
export class AcpAgentProcess {
  private proc: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;

  constructor(
    public readonly agentId: string,
    private readonly config: AcpAgentConfig,
    private readonly clientFactory: AcpClientFactory,
  ) {}

  /**
   * Spawns the agent command as a child process and sets up the ACP connection.
   */
  spawn(cwd: string): void {
    log.info(
      { agentId: this.agentId, command: this.config.command, cwd },
      "Spawning ACP agent process",
    );

    this.proc = spawn(this.config.command, this.config.args, {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.config.env },
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(
        this.proc.stdout!,
      ) as unknown as ReadableStream<Uint8Array>,
    );

    this.connection = new acp.ClientSideConnection(
      (agent) => this.clientFactory(agent),
      stream,
    );

    // Handle process exit
    this.proc.on("exit", (code) => {
      this.handleProcessExit(code);
    });

    this.proc.on("error", (err) => {
      log.error(
        { agentId: this.agentId, error: err.message },
        "ACP agent process error",
      );
    });
  }

  /**
   * Initializes the ACP connection by negotiating protocol version and capabilities.
   */
  async initialize(): Promise<InitializeResponse> {
    if (!this.connection) {
      throw new Error(`ACP agent "${this.agentId}" is not spawned`);
    }

    log.info({ agentId: this.agentId }, "Initializing ACP connection");

    return this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "vellum", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  }

  /**
   * Creates a new ACP session in the specified working directory.
   * Returns the session ID.
   */
  async createSession(cwd: string): Promise<string> {
    if (!this.connection) {
      throw new Error(`ACP agent "${this.agentId}" is not spawned`);
    }

    log.info({ agentId: this.agentId, cwd }, "Creating ACP session");

    const result: NewSessionResponse = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });

    return result.sessionId;
  }

  /**
   * Sends a prompt to an existing ACP session.
   * Returns the prompt response (includes stopReason).
   */
  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    if (!this.connection) {
      throw new Error(`ACP agent "${this.agentId}" is not spawned`);
    }

    log.info(
      { agentId: this.agentId, sessionId },
      "Sending prompt to ACP agent",
    );

    return this.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  /**
   * Cancels an ongoing prompt in the specified session.
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) {
      throw new Error(`ACP agent "${this.agentId}" is not spawned`);
    }

    log.info(
      { agentId: this.agentId, sessionId },
      "Cancelling ACP session prompt",
    );

    await this.connection.cancel({ sessionId });
  }

  /**
   * Kills the child process and cleans up the connection.
   */
  kill(): void {
    log.info({ agentId: this.agentId }, "Killing ACP agent process");

    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.connection = null;
  }

  /**
   * Whether the child process is still running.
   */
  get isAlive(): boolean {
    if (!this.proc) return false;
    // ChildProcess.exitCode is null while process is still running
    // exitCode is null while the process is still running
    return this.proc.exitCode == null;
  }

  /**
   * Handles process exit by logging the event.
   */
  private handleProcessExit(code: number | null): void {
    if (code != undefined && code !== 0) {
      log.error(
        { agentId: this.agentId, exitCode: code },
        "ACP agent process exited with error",
      );
    } else {
      log.info(
        { agentId: this.agentId, exitCode: code },
        "ACP agent process exited",
      );
    }

    this.proc = null;
    this.connection = null;
  }
}

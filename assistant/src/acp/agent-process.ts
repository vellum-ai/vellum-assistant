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
  AuthMethod,
  AuthMethodEnvVar,
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
 * JSON-RPC error code agents use to signal that authentication is required
 * (matches the SDK's RequestError.authRequired()).
 */
const AUTH_REQUIRED_CODE = -32000;

/**
 * Detects the ACP auth-required error. Checks the `code` property rather than
 * `instanceof acp.RequestError` so plain JSON-RPC error objects are also
 * recognized.
 */
function isAuthRequiredError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === AUTH_REQUIRED_CODE
  );
}

function isEnvVarMethod(
  method: AuthMethod,
): method is AuthMethodEnvVar & { type: "env_var" } {
  return "type" in method && method.type === "env_var";
}

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
  private initializeResponse: InitializeResponse | null = null;
  /**
   * Merged env captured at spawn() so auth satisfiability checks match the
   * env the child process actually received, even if process.env changes
   * afterwards.
   */
  private spawnedEnv: NodeJS.ProcessEnv | null = null;

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

    this.spawnedEnv = { ...process.env, ...this.config.env };
    this.proc = spawn(this.config.command, this.config.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.spawnedEnv,
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

    // Capture stderr so agent crash details appear in logs
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log.error({ agentId: this.agentId, stderr: text }, "ACP agent stderr");
      }
    });

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
    const connection = this.requireConnection();

    log.info({ agentId: this.agentId }, "Initializing ACP connection");

    const response = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "vellum", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    this.initializeResponse = response;
    return response;
  }

  /**
   * Whether the agent advertised support for `session/load` at initialize.
   * Returns false before initialize() resolves.
   */
  get supportsLoadSession(): boolean {
    return this.initializeResponse?.agentCapabilities?.loadSession === true;
  }

  /**
   * Whether the agent advertised support for `session/resume` at initialize.
   * Returns false before initialize() resolves.
   */
  get supportsSessionResume(): boolean {
    return (
      this.initializeResponse?.agentCapabilities?.sessionCapabilities?.resume !=
      null
    );
  }

  /**
   * Authentication methods the agent advertised at initialize.
   * Returns an empty array before initialize() resolves.
   */
  private get authMethods(): AuthMethod[] {
    return this.initializeResponse?.authMethods ?? [];
  }

  /**
   * Selects the first advertised env_var auth method whose required variables
   * are all present (non-empty) in the env the agent process was spawned with.
   *
   * Terminal-type and agent-driven (untyped) methods are never selected:
   * auto-triggering an interactive login would hang the headless daemon.
   */
  private selectEnvVarAuthMethod(): AuthMethod | undefined {
    const env = this.spawnedEnv;
    if (!env) return undefined;

    return this.authMethods.find((method) => {
      if (!isEnvVarMethod(method)) return false;

      // `vars` is required by the SDK type, but agent responses aren't
      // runtime-validated — tolerate an out-of-spec agent omitting it so the
      // caller gets the friendly auth error instead of a TypeError.
      const requiredVars = (method.vars ?? []).filter((v) => !v.optional);
      if (requiredVars.length === 0) return false;

      return requiredVars.every((v) => {
        const value = env[v.name];
        return typeof value === "string" && value.length > 0;
      });
    });
  }

  /**
   * Returns the live connection, throwing the standard not-spawned error if
   * the agent was never spawned or its process has since exited.
   */
  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) {
      throw new Error(`ACP agent "${this.agentId}" is not spawned`);
    }
    return this.connection;
  }

  /**
   * Runs an operation, and if the agent rejects with the ACP auth-required
   * error, authenticates via a satisfiable env_var auth method and retries
   * the operation exactly once.
   */
  private async withAuthRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;

      // The agent may have exited between the auth_required rejection and
      // this retry path; fail with the standard not-spawned error.
      const connection = this.requireConnection();

      const method = this.selectEnvVarAuthMethod();
      if (!method) {
        throw new Error(
          `ACP agent "${this.agentId}" requires authentication. ` +
            `Advertised methods: ${this.describeAuthMethods()}. ` +
            "Set the required env var under acp.agents.<id>.env in config.json, " +
            "store it via 'assistant credentials set --service acp --field <field>', " +
            "or complete the agent's own login flow in the workspace.",
        );
      }

      log.info(
        { agentId: this.agentId, methodId: method.id },
        "ACP agent returned auth_required; authenticating with env_var method",
      );

      await connection.authenticate({ methodId: method.id });
      return await op();
    }
  }

  /**
   * Renders the agent's advertised auth methods for error messages, e.g.
   * `"Login with ChatGPT" (chatgpt), "Use OPENAI_API_KEY" (env var OPENAI_API_KEY)`.
   */
  private describeAuthMethods(): string {
    if (this.authMethods.length === 0) return "none";

    return this.authMethods
      .map((method) => {
        // `vars ?? []`: tolerate out-of-spec agents omitting the field —
        // this renders inside the friendly auth error, which must not
        // itself throw a TypeError.
        const varNames = isEnvVarMethod(method)
          ? (method.vars ?? []).map((v) => v.name).join(", ")
          : "";
        return varNames
          ? `"${method.name}" (env var ${varNames})`
          : `"${method.name}" (${method.id})`;
      })
      .join(", ");
  }

  /**
   * Creates a new ACP session in the specified working directory.
   * Returns the session ID.
   */
  async createSession(cwd: string): Promise<string> {
    log.info({ agentId: this.agentId, cwd }, "Creating ACP session");

    const result: NewSessionResponse = await this.withAuthRetry(() =>
      this.requireConnection().newSession({ cwd, mcpServers: [] }),
    );

    return result.sessionId;
  }

  /**
   * Loads a previously persisted ACP session via `session/load`.
   *
   * Per the ACP spec, the agent replays the session's conversation history
   * as `session/update` notifications before the load response resolves;
   * callers should suppress forwarding of those replayed updates (see
   * VellumAcpClientHandler.beginReplaySuppression).
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    log.info({ agentId: this.agentId, sessionId, cwd }, "Loading ACP session");

    await this.withAuthRetry(() =>
      this.requireConnection().loadSession({ sessionId, cwd, mcpServers: [] }),
    );
  }

  /**
   * Resumes a previously persisted ACP session via `session/resume`.
   *
   * Unlike `session/load`, resume performs no history replay, so it is
   * preferred when the agent advertises the capability
   * (see supportsSessionResume).
   */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    log.info({ agentId: this.agentId, sessionId, cwd }, "Resuming ACP session");

    await this.withAuthRetry(() =>
      this.requireConnection().resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
      }),
    );
  }

  /**
   * Sends a prompt to an existing ACP session.
   * Returns the prompt response (includes stopReason).
   */
  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    log.info(
      { agentId: this.agentId, sessionId },
      "Sending prompt to ACP agent",
    );

    return this.withAuthRetry(() =>
      this.requireConnection().prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    );
  }

  /**
   * Cancels an ongoing prompt in the specified session.
   */
  async cancel(sessionId: string): Promise<void> {
    const connection = this.requireConnection();

    log.info(
      { agentId: this.agentId, sessionId },
      "Cancelling ACP session prompt",
    );

    await connection.cancel({ sessionId });
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
    this.initializeResponse = null;
    this.spawnedEnv = null;
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
    this.initializeResponse = null;
    this.spawnedEnv = null;
  }
}

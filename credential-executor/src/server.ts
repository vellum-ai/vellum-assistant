/**
 * CES RPC server.
 *
 * Implements the server-side of the CES wire protocol defined in
 * `@vellumai/ces-contracts`. The server reads newline-delimited JSON
 * messages from a readable stream, dispatches them through the RPC
 * contract, and writes responses back to a writable stream.
 *
 * Transport-agnostic: callers provide the readable/writable pair.
 * - Local mode: stdin/stdout
 * - Managed mode: the accepted Unix socket stream
 *
 * The server handles the handshake, validates envelopes, dispatches
 * method calls, and sends structured responses or errors.
 */

import type { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  CesRpcSchemas,
  hashProposal,
  type CommandGrantProposal,
  type HandshakeAck,
  type HandshakeRequest,
  type MakeAuthenticatedRequest,
  type ManageSecureCommandTool,
  type ManageSecureCommandToolResponse,
  type RpcEnvelope,
  type RunAuthenticatedCommand,
  type RunAuthenticatedCommandResponse,
  type TransportMessage,
  TransportMessageSchema,
} from "@vellumai/ces-contracts";

import { resolve } from "node:path";

import {
  executeAuthenticatedCommand,
  type CommandExecutorDeps,
  type ExecuteCommandRequest,
} from "./commands/executor.js";

import { validateContainedPath } from "./commands/workspace.js";

import {
  executeAuthenticatedHttpRequest,
  type HttpExecutorDeps,
} from "./http/executor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mutable reference to the current session ID. Allows handlers that are
 * registered before the RPC handshake to read the actual handshake session
 * ID at call time (after the handshake completes and sets `.current`).
 */
export interface SessionIdRef {
  current: string;
}

/**
 * Handler function for a single RPC method. Receives the validated
 * request payload and returns the response payload (or throws).
 */
export type RpcMethodHandler<TReq = unknown, TRes = unknown> = (
  request: TReq,
) => Promise<TRes> | TRes;

/**
 * Registry of method name to handler function.
 */
export type RpcHandlerRegistry = Partial<
  Record<string, RpcMethodHandler>
>;

export interface CesServerOptions {
  /** Readable stream to consume messages from. */
  input: Readable;
  /** Writable stream to send responses to. */
  output: Writable;
  /** Map of RPC method names to handler functions. */
  handlers: RpcHandlerRegistry;
  /** Optional logger (defaults to console). */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Optional abort signal to shut down the server. */
  signal?: AbortSignal;
  /** Callback invoked when the handshake completes with the negotiated session ID and optional API key. */
  onHandshakeComplete?: (sessionId: string, assistantApiKey?: string) => void;
  /** Callback invoked when the assistant pushes an updated API key after hatch. */
  onApiKeyUpdate?: (assistantApiKey: string) => void;
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export class CesRpcServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly handlers: RpcHandlerRegistry;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly signal?: AbortSignal;
  private readonly onHandshakeComplete?: (sessionId: string, assistantApiKey?: string) => void;

  private handshakeComplete = false;
  private sessionId: string | null = null;
  private buffer = "";
  private closed = false;

  constructor(options: CesServerOptions) {
    this.input = options.input;
    this.output = options.output;
    this.handlers = options.handlers;
    this.logger = options.logger ?? console;
    this.signal = options.signal;
    this.onHandshakeComplete = options.onHandshakeComplete;

    // Auto-register the update_managed_credential handler if a callback is provided.
    if (options.onApiKeyUpdate) {
      const onUpdate = options.onApiKeyUpdate;
      this.handlers[CesRpcMethod.UpdateManagedCredential] = (request: unknown) => {
        const { assistantApiKey } = request as { assistantApiKey: string };
        onUpdate(assistantApiKey);
        return { updated: true };
      };
    }
  }

  /**
   * Start serving. Returns a promise that resolves when the input stream
   * ends or the abort signal fires.
   */
  async serve(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.signal?.aborted) {
        this.close();
        resolve();
        return;
      }

      const onAbort = () => {
        this.close();
        resolve();
      };

      if (this.signal) {
        this.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.input.on("data", (chunk: Buffer | string) => {
        if (this.closed) return;
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        this.processBuffer();
      });

      this.input.on("end", () => {
        if (this.signal) {
          this.signal.removeEventListener("abort", onAbort);
        }
        this.close();
        resolve();
      });

      this.input.on("error", (err) => {
        if (this.signal) {
          this.signal.removeEventListener("abort", onAbort);
        }
        this.close();
        reject(err);
      });
    });
  }

  /** Whether the server has completed the handshake. */
  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }

  /** The session ID established during handshake (null before handshake). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Shut down the server gracefully, destroying transport streams. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.destroy();
    if (typeof (this.output as any).destroy === "function") {
      this.output.destroy();
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger.warn("[ces-server] Failed to parse JSON line:", line);
      return;
    }

    // Parse as a transport message
    const msgResult = TransportMessageSchema.safeParse(parsed);
    if (!msgResult.success) {
      this.logger.warn(
        "[ces-server] Invalid transport message:",
        msgResult.error,
      );
      return;
    }

    const msg = msgResult.data as TransportMessage;

    if (msg.type === "handshake_request") {
      if (this.handshakeComplete) {
        this.logger.warn("[ces-server] Duplicate handshake_request after session established; rejecting");
        const ack: HandshakeAck = {
          type: "handshake_ack",
          protocolVersion: CES_PROTOCOL_VERSION,
          sessionId: (msg as HandshakeRequest).sessionId,
          accepted: false,
          reason: "Session already established",
        };
        this.sendMessage(ack);
        return;
      }
      this.handleHandshake(msg as HandshakeRequest);
    } else if (msg.type === "rpc") {
      this.handleRpcEnvelope(msg as unknown as RpcEnvelope).catch((err) => {
        this.logger.error(`[ces-server] Unhandled error in RPC handler: ${err}`);
      });
    } else {
      this.logger.warn("[ces-server] Unexpected message type:", msg.type);
    }
  }

  private handleHandshake(req: HandshakeRequest): void {
    const accepted = req.protocolVersion === CES_PROTOCOL_VERSION;
    const ack: HandshakeAck = {
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: req.sessionId,
      accepted,
      ...(accepted ? {} : { reason: `Unsupported protocol version: ${req.protocolVersion}` }),
    };

    if (accepted) {
      this.handshakeComplete = true;
      this.sessionId = req.sessionId;
      this.logger.log(`[ces-server] Handshake accepted for session ${req.sessionId}`);
      this.onHandshakeComplete?.(req.sessionId, req.assistantApiKey);
    } else {
      this.logger.warn(
        `[ces-server] Handshake rejected: version mismatch (got ${req.protocolVersion}, expected ${CES_PROTOCOL_VERSION})`,
      );
    }

    this.sendMessage(ack);
  }

  private async handleRpcEnvelope(envelope: RpcEnvelope): Promise<void> {
    if (!this.handshakeComplete) {
      this.logger.warn("[ces-server] RPC received before handshake; ignoring");
      this.sendRpcError(envelope, "HANDSHAKE_REQUIRED", "Handshake not completed");
      return;
    }

    if (envelope.kind !== "request") {
      // Server only processes requests; responses are ignored
      return;
    }

    const method = envelope.method;
    const handler = this.handlers[method];

    if (!handler) {
      this.sendRpcError(envelope, "METHOD_NOT_FOUND", `Unknown method: ${method}`);
      return;
    }

    // Validate the request payload against the registered schema (if available)
    const schemas = CesRpcSchemas[method as CesRpcMethod];
    let validatedPayload = envelope.payload;

    if (schemas) {
      const parseResult = schemas.request.safeParse(envelope.payload);
      if (!parseResult.success) {
        this.sendRpcError(
          envelope,
          "INVALID_REQUEST",
          `Invalid payload for ${method}: ${parseResult.error.message}`,
        );
        return;
      }
      validatedPayload = parseResult.data;
    }

    try {
      const result = await handler(validatedPayload);
      this.sendRpcResponse(envelope, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendRpcError(envelope, "HANDLER_ERROR", message);
    }
  }

  private sendRpcResponse(request: RpcEnvelope, payload: unknown): void {
    const response: RpcEnvelope & { type: "rpc" } = {
      type: "rpc",
      id: request.id,
      kind: "response",
      method: request.method,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.sendMessage(response);
  }

  private sendRpcError(
    request: RpcEnvelope,
    code: string,
    message: string,
  ): void {
    const response: RpcEnvelope & { type: "rpc" } = {
      type: "rpc",
      id: request.id,
      kind: "response",
      method: request.method,
      payload: {
        success: false,
        error: { code, message },
      },
      timestamp: new Date().toISOString(),
    };
    this.sendMessage(response);
  }

  private sendMessage(msg: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(msg) + "\n";
    this.output.write(line);
  }
}

// ---------------------------------------------------------------------------
// Handler factory: make_authenticated_request
// ---------------------------------------------------------------------------

/**
 * Create a handler function for the `make_authenticated_request` RPC method.
 *
 * Binds the executor to the provided dependencies so it can be registered
 * in the RPC handler registry.
 */
export function createMakeAuthenticatedRequestHandler(
  deps: HttpExecutorDeps,
): RpcMethodHandler {
  return async (request: unknown) => {
    return executeAuthenticatedHttpRequest(
      request as MakeAuthenticatedRequest,
      deps,
    );
  };
}

/**
 * Build an RPC handler registry that includes the `make_authenticated_request`
 * handler alongside any additional handlers.
 *
 * This is a convenience helper for callers that want to wire up the HTTP
 * executor without manually constructing the registry.
 */
export function buildHandlersWithHttp(
  httpDeps: HttpExecutorDeps,
  additionalHandlers?: RpcHandlerRegistry,
): RpcHandlerRegistry {
  return {
    ...additionalHandlers,
    [CesRpcMethod.MakeAuthenticatedRequest]:
      createMakeAuthenticatedRequestHandler(httpDeps),
  };
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a CES RPC server with the given options and start serving.
 *
 * This is the primary entrypoint for both local and managed modes —
 * callers just provide different input/output streams.
 */
export function createCesServer(options: CesServerOptions): CesRpcServer {
  return new CesRpcServer(options);
}

// ---------------------------------------------------------------------------
// run_authenticated_command handler factory
// ---------------------------------------------------------------------------

/**
 * Options for creating the `run_authenticated_command` RPC handler.
 */
export interface RunAuthenticatedCommandHandlerOptions {
  /** Dependencies for the command executor. */
  executorDeps: CommandExecutorDeps;
  /**
   * Default workspace directory for commands that don't specify one.
   * Typically the assistant's workspace root.
   */
  defaultWorkspaceDir: string;
}

/**
 * Create an RPC handler for the `run_authenticated_command` method.
 *
 * This handler:
 * 1. Parses the `command` string into a bundleDigest, profileName, and argv.
 *    The expected format is: `<bundleDigest>/<profileName> <argv...>`
 * 2. Delegates to `executeAuthenticatedCommand` for the full security pipeline.
 * 3. Returns a `RunAuthenticatedCommandResponse` with the execution result.
 *
 * If the command string doesn't match the expected format (i.e. it's a
 * plain shell command), the handler returns a structured error since only
 * manifest-driven secure commands are supported.
 */
export function createRunAuthenticatedCommandHandler(
  options: RunAuthenticatedCommandHandlerOptions,
): RpcMethodHandler<RunAuthenticatedCommand, RunAuthenticatedCommandResponse> {
  return async (request) => {
    // Parse the command string into bundle-digest/profile and argv
    const parseResult = parseCommandString(request.command);
    if (!parseResult.ok) {
      return {
        success: false,
        error: { code: "INVALID_COMMAND", message: parseResult.error },
      };
    }

    // Validate cwd when inputs or outputs are present — the workspace
    // staging/copyback pipeline resolves paths relative to workspaceDir,
    // so an unvalidated cwd could let a caller read/write outside the
    // assistant workspace.
    const workspaceDir = request.cwd ?? options.defaultWorkspaceDir;
    const hasWorkspaceIO =
      (request.inputs && request.inputs.length > 0) ||
      (request.outputs && request.outputs.length > 0);

    if (hasWorkspaceIO && request.cwd) {
      const resolvedCwd = resolve(request.cwd);
      const cwdError = validateContainedPath(
        resolvedCwd,
        options.defaultWorkspaceDir,
        "Command cwd",
      );
      if (cwdError) {
        return {
          success: false,
          error: {
            code: "INVALID_CWD",
            message:
              `cwd cannot be used with inputs/outputs when it resolves outside ` +
              `the workspace directory: ${cwdError}`,
          },
        };
      }
    }

    const execRequest: ExecuteCommandRequest = {
      bundleDigest: parseResult.bundleDigest,
      profileName: parseResult.profileName,
      credentialHandle: request.credentialHandle,
      argv: parseResult.argv,
      workspaceDir,
      inputs: request.inputs,
      outputs: request.outputs,
      purpose: request.purpose,
      grantId: request.grantId,
      conversationId: request.conversationId,
    };

    const result = await executeAuthenticatedCommand(
      execRequest,
      options.executorDeps,
    );

    // If the failure was due to a missing grant, return a structured
    // APPROVAL_REQUIRED response with the proposal so the approval
    // bridge can activate.
    if (!result.success && result.approvalRequired) {
      const { credentialHandle, bundleDigest, profileName, command, purpose } =
        result.approvalRequired;

      const proposal: CommandGrantProposal = {
        type: "command",
        credentialHandle,
        command,
        purpose,
        allowedCommandPatterns: [`${credentialHandle}:${bundleDigest}:${profileName}`],
      };

      return {
        success: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: `No active grant covers this command. Approval is required.`,
          details: {
            proposal,
            proposalHash: hashProposal(proposal),
          },
        },
        auditId: result.auditId,
      };
    }

    return {
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
        ? { code: "EXECUTION_ERROR", message: result.error }
        : undefined,
      auditId: result.auditId,
    };
  };
}

/**
 * Parse a CES command string into bundle digest, profile name, and argv.
 *
 * Expected format: `<bundleDigest>/<profileName> [argv...]`
 *
 * Examples:
 * - `abc123def.../api-read api /repos/owner/repo --method GET`
 * - `abc123def.../list-repos`
 */
function parseCommandString(
  command: string,
): { ok: true; bundleDigest: string; profileName: string; argv: string[] }
  | { ok: false; error: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: "Command string is empty" };
  }

  // Split on first space to separate the bundle/profile reference from argv
  const firstSpaceIdx = trimmed.indexOf(" ");
  const ref = firstSpaceIdx === -1 ? trimmed : trimmed.slice(0, firstSpaceIdx);
  const argvStr = firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx + 1).trim();

  // Parse the reference: <bundleDigest>/<profileName>
  const slashIdx = ref.indexOf("/");
  if (slashIdx === -1 || slashIdx === 0 || slashIdx === ref.length - 1) {
    return {
      ok: false,
      error: `Invalid command reference "${ref}". Expected format: "<bundleDigest>/<profileName> [argv...]"`,
    };
  }

  const bundleDigest = ref.slice(0, slashIdx);
  const profileName = ref.slice(slashIdx + 1);

  // Parse argv — split on whitespace (simple tokenization)
  const argv = argvStr ? argvStr.split(/\s+/).filter((s) => s.length > 0) : [];

  return { ok: true, bundleDigest, profileName, argv };
}

/**
 * Convenience helper to register the `run_authenticated_command` handler
 * into an RPC handler registry.
 */
export function registerCommandExecutionHandler(
  registry: RpcHandlerRegistry,
  options: RunAuthenticatedCommandHandlerOptions,
): void {
  registry[CesRpcMethod.RunAuthenticatedCommand] =
    createRunAuthenticatedCommandHandler(options) as RpcMethodHandler;
}

// ---------------------------------------------------------------------------
// manage_secure_command_tool handler factory
// ---------------------------------------------------------------------------

/**
 * Dependencies for the `manage_secure_command_tool` handler.
 */
export interface ManageSecureCommandToolHandlerDeps {
  /**
   * Download bundle bytes from the given HTTPS URL.
   * Implementations should enforce size limits and timeouts.
   */
  downloadBundle: (sourceUrl: string) => Promise<Buffer | Uint8Array>;

  /**
   * Publish a bundle into the CES-private toolstore.
   * Typically delegates to `publishBundle()` from `./toolstore/publish.js`.
   */
  publishBundle: (request: import("./toolstore/publish.js").PublishRequest) => import("./toolstore/publish.js").PublishResult;

  /**
   * Unregister/remove a tool from the tool registry by name.
   * Returns true if the tool was found and removed.
   */
  unregisterTool: (toolName: string) => boolean;

  /**
   * Register a tool in the tool registry after successful publication.
   * Called with the tool name, credential handle, description, and the
   * bundle digest for runtime lookup.
   */
  registerTool: (entry: {
    toolName: string;
    credentialHandle: string;
    description: string;
    bundleDigest: string;
  }) => void;
}

/**
 * Create an RPC handler for the `manage_secure_command_tool` method.
 *
 * This handler:
 * 1. For "register" actions: validates required bundle metadata fields,
 *    downloads the bundle from `sourceUrl`, publishes it into the
 *    immutable toolstore with digest verification, and registers
 *    the tool entry.
 * 2. For "unregister" actions: removes the tool from the registry.
 */
export function createManageSecureCommandToolHandler(
  deps: ManageSecureCommandToolHandlerDeps,
): RpcMethodHandler<ManageSecureCommandTool, ManageSecureCommandToolResponse> {
  return async (request) => {
    if (request.action === "unregister") {
      const removed = deps.unregisterTool(request.toolName);
      if (!removed) {
        return {
          success: false,
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool "${request.toolName}" is not registered.`,
          },
        };
      }
      return { success: true };
    }

    // action === "register"
    const missing: string[] = [];
    if (!request.bundleId) missing.push("bundleId");
    if (!request.version) missing.push("version");
    if (!request.sourceUrl) missing.push("sourceUrl");
    if (!request.sha256) missing.push("sha256");
    if (!request.credentialHandle) missing.push("credentialHandle");
    if (!request.description) missing.push("description");
    if (!request.secureCommandManifest) missing.push("secureCommandManifest");
    if (missing.length > 0) {
      return {
        success: false,
        error: {
          code: "MISSING_FIELDS",
          message: `Register action requires: ${missing.join(", ")}`,
        },
      };
    }

    // Validate HTTPS before downloading — CES is the security boundary
    // and must not rely on the caller for URL scheme validation.
    try {
      const parsed = new URL(request.sourceUrl!);
      if (parsed.protocol !== "https:") {
        return {
          success: false,
          error: {
            code: "INVALID_SOURCE_URL",
            message: "sourceUrl must use HTTPS for secure bundle downloads.",
          },
        };
      }
    } catch {
      return {
        success: false,
        error: {
          code: "INVALID_SOURCE_URL",
          message: "sourceUrl is not a valid URL.",
        },
      };
    }

    // Download the bundle
    let bundleBytes: Buffer | Uint8Array;
    try {
      bundleBytes = await deps.downloadBundle(request.sourceUrl!);
    } catch (err) {
      return {
        success: false,
        error: {
          code: "DOWNLOAD_FAILED",
          message: `Failed to download bundle from ${request.sourceUrl}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    // The caller provides the full secure command manifest via the RPC
    // payload. Cast to the internal type — publishBundle() validates it.
    const secureCommandManifest =
      request.secureCommandManifest as unknown as import("./commands/profiles.js").SecureCommandManifest;

    // Publish into the immutable toolstore (includes digest verification)
    const publishResult = deps.publishBundle({
      bundleBytes,
      expectedDigest: request.sha256!,
      bundleId: request.bundleId!,
      version: request.version!,
      sourceUrl: request.sourceUrl!,
      secureCommandManifest,
    });

    if (!publishResult.success) {
      return {
        success: false,
        error: {
          code: "PUBLISH_FAILED",
          message: publishResult.error ?? "Unknown publish error",
        },
      };
    }

    // Register the tool entry for runtime lookup
    deps.registerTool({
      toolName: request.toolName,
      credentialHandle: request.credentialHandle!,
      description: request.description!,
      bundleDigest: request.sha256!,
    });

    return { success: true };
  };
}

/**
 * Convenience helper to register the `manage_secure_command_tool` handler
 * into an RPC handler registry.
 */
export function registerManageSecureCommandToolHandler(
  registry: RpcHandlerRegistry,
  deps: ManageSecureCommandToolHandlerDeps,
): void {
  registry[CesRpcMethod.ManageSecureCommandTool] =
    createManageSecureCommandToolHandler(deps) as RpcMethodHandler;
}

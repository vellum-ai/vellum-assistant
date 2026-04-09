/**
 * ACP client handler — bridges ACP agent events to Vellum's SSE message protocol.
 *
 * Implements the ACP SDK's Client interface, forwarding session updates,
 * permission requests, file operations, and terminal management to
 * connected Vellum clients.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../daemon/message-protocol.js";
import type { UserDecision } from "../permissions/types.js";
import { isPermissionControlsV2Enabled } from "../permissions/v2-consent-policy.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("acp:client-handler");

interface TerminalState {
  proc: ChildProcess;
  output: string;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
}

/**
 * Vellum's ACP Client handler. Receives events from an ACP agent and
 * forwards them as ServerMessage objects to connected Vellum clients.
 */
export class VellumAcpClientHandler implements Client {
  private terminals = new Map<string, TerminalState>();
  private accumulatedText = "";
  /** Tracks pending ACP permission requestIds for cleanup on session close. */
  readonly pendingRequestIds = new Set<string>();

  /** Returns the full agent response text accumulated from agent_message_chunk events. */
  get responseText(): string {
    return this.accumulatedText;
  }

  constructor(
    private readonly acpSessionId: string,
    private readonly sendToVellum: (msg: ServerMessage) => void,
    private readonly parentConversationId: string,
  ) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    log.debug(
      { acpSessionId: this.acpSessionId, updateType: update.sessionUpdate },
      "ACP session update received",
    );

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractText(update.content);
        this.accumulatedText += text;
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "agent_message_chunk",
          content: text,
        });
        break;
      }

      case "user_message_chunk": {
        const text = extractText(update.content);
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "user_message_chunk",
          content: text,
        });
        break;
      }

      case "tool_call": {
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "tool_call",
          toolCallId: update.toolCallId,
          toolTitle: update.title,
          toolKind: update.kind,
          toolStatus: update.status,
        });
        break;
      }

      case "tool_call_update": {
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "tool_call_update",
          toolCallId: update.toolCallId,
          toolStatus: update.status ?? undefined,
          content: update.content ? JSON.stringify(update.content) : undefined,
        });
        break;
      }

      case "plan": {
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "plan",
          content: JSON.stringify(update.entries),
        });
        break;
      }

      default: {
        // Other update types (agent_thought_chunk, available_commands_update,
        // current_mode_update, config_option_update, session_info_update,
        // usage_update) are not forwarded to Vellum.
        log.debug(
          {
            acpSessionId: this.acpSessionId,
            updateType: (update as { sessionUpdate: string }).sessionUpdate,
          },
          "Ignoring unhandled session update type",
        );
        break;
      }
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    const toolTitle = params.toolCall.title ?? "Unknown tool";
    const toolKind = params.toolCall.kind ?? "other";
    const options = params.options;

    log.info(
      {
        acpSessionId: this.acpSessionId,
        requestId,
        toolTitle,
        toolKind,
        optionCount: options.length,
      },
      "ACP permission requested",
    );

    // Normalize rawInput into a Record for the confirmation_request shape
    const rawInput = params.toolCall.rawInput;
    const input: Record<string, unknown> =
      rawInput != null &&
      typeof rawInput === "object" &&
      !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : { command: rawInput };

    const toolName = `ACP Agent: ${toolTitle}`;
    const acpOptions = options.map((opt) => ({
      optionId: opt.optionId,
      name: opt.name,
      kind: opt.kind,
    }));

    if (isPermissionControlsV2Enabled()) {
      return {
        outcome: {
          outcome: "selected",
          optionId: mapDecisionToOptionId("deny", options),
        },
      };
    }

    // Send the confirmation_request first — this triggers makeEventSender
    // which registers a normal "confirmation" entry in pendingInteractions.
    this.sendToVellum({
      type: "confirmation_request",
      requestId,
      toolName,
      input,
      riskLevel: "medium",
      allowlistOptions: [],
      scopeOptions: [],
      persistentDecisionsAllowed: false,
      acpToolKind: toolKind,
      acpOptions,
      conversationId: this.parentConversationId,
    });

    // Now overwrite with our ACP registration that has directResolve.
    // This must come AFTER sendToVellum so it wins over makeEventSender's
    // registration.
    const optionIdPromise = new Promise<string>((resolve) => {
      const timeoutMs = 5 * 60 * 1000; // 5 minutes
      const timer = setTimeout(() => {
        const pending = pendingInteractions.resolve(requestId);
        if (pending?.directResolve) {
          pending.directResolve("deny");
        }
      }, timeoutMs);

      this.pendingRequestIds.add(requestId);
      pendingInteractions.register(requestId, {
        conversation: null,
        conversationId: this.parentConversationId,
        kind: "acp_confirmation",
        confirmationDetails: {
          toolName,
          input,
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
          persistentDecisionsAllowed: false,
          acpToolKind: toolKind,
          acpOptions,
        },
        directResolve: (decision: UserDecision) => {
          clearTimeout(timer);
          this.pendingRequestIds.delete(requestId);
          const optionId = mapDecisionToOptionId(decision, options);
          resolve(optionId);
        },
      });
    });

    const optionId = await optionIdPromise;
    log.info(
      { acpSessionId: this.acpSessionId, requestId, optionId },
      "ACP permission resolved",
    );
    return { outcome: { outcome: "selected", optionId } };
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    log.debug(
      { acpSessionId: this.acpSessionId, path: params.path },
      "ACP readTextFile",
    );
    const content = await Bun.file(params.path).text();
    return { content };
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    log.info(
      { acpSessionId: this.acpSessionId, path: params.path },
      "ACP writeTextFile",
    );
    await Bun.write(params.path, params.content);
    return {};
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const terminalId = randomUUID();
    log.info(
      {
        acpSessionId: this.acpSessionId,
        terminalId,
        command: params.command,
        args: params.args,
      },
      "ACP createTerminal",
    );

    const args = params.args ?? [];
    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    if (params.env) {
      for (const { name, value } of params.env) {
        env[name] = value;
      }
    }

    const proc = spawn(params.command, args, {
      cwd: params.cwd ?? undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const state: TerminalState = {
      proc,
      output: "",
      exited: false,
      exitCode: null,
      signal: null,
      exitPromise: Promise.resolve(),
    };

    proc.on("error", (err) => {
      log.error({ terminalId, error: err.message }, "Terminal process error");
      state.exited = true;
      state.exitCode = 1;
      state.signal = null;
    });

    state.exitPromise = new Promise<void>((resolve) => {
      proc.on("exit", (code, signal) => {
        state.exited = true;
        state.exitCode = code;
        state.signal = signal;
        resolve();
      });
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      state.output += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      state.output += chunk.toString();
    });

    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    const state = this.terminals.get(params.terminalId);
    if (!state) {
      return { output: "", truncated: false };
    }

    return {
      output: state.output,
      truncated: false,
      exitStatus: state.exited
        ? {
            exitCode: state.exitCode,
            signal: state.signal,
          }
        : null,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const state = this.terminals.get(params.terminalId);
    if (!state) {
      return { exitCode: null, signal: null };
    }

    await state.exitPromise;
    return { exitCode: state.exitCode, signal: state.signal };
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    const state = this.terminals.get(params.terminalId);
    if (state && !state.exited) {
      state.proc.kill();
    }
    return {};
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    const state = this.terminals.get(params.terminalId);
    if (state) {
      if (!state.exited) {
        state.proc.kill();
      }
      this.terminals.delete(params.terminalId);
    }
    return {};
  }
}

/**
 * Maps a UserDecision to the best-matching ACP option ID.
 */
function mapDecisionToOptionId(
  decision: UserDecision,
  options: Array<{ optionId: string; kind: string }>,
): string {
  const isAllow =
    decision === "allow" ||
    decision === "allow_10m" ||
    decision === "allow_conversation" ||
    decision === "always_allow" ||
    decision === "always_allow_high_risk" ||
    decision === "temporary_override";

  if (isAllow) {
    // Prefer allow_always for persistent decisions, fallback to allow_once
    if (decision === "always_allow" || decision === "always_allow_high_risk") {
      const alwaysOpt = options.find((o) => o.kind === "allow_always");
      if (alwaysOpt) return alwaysOpt.optionId;
    }
    const allowOpt =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => o.kind === "allow_always");
    if (allowOpt) return allowOpt.optionId;
  }

  // Deny: prefer reject_always for persistent deny, fallback to reject_once
  if (decision === "always_deny") {
    const alwaysDeny = options.find((o) => o.kind === "reject_always");
    if (alwaysDeny) return alwaysDeny.optionId;
  }
  const denyOpt =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always");
  if (denyOpt) return denyOpt.optionId;

  // Fallback: return first option
  return options[0]?.optionId ?? "deny";
}

/**
 * Extracts text from a ContentBlock.
 */
function extractText(content: { type?: string; text?: string }): string {
  if (content && "text" in content && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

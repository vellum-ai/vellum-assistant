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

  constructor(
    private readonly acpSessionId: string,
    private readonly sendToVellum: (msg: ServerMessage) => void,
    private readonly pendingPermissions: Map<
      string,
      { resolve: (optionId: string) => void }
    >,
  ) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractText(update.content);
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
          updateType: "agent_message_chunk",
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

    const optionIdPromise = new Promise<string>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve });
    });

    this.sendToVellum({
      type: "acp_permission_request",
      acpSessionId: this.acpSessionId,
      requestId,
      toolTitle: params.toolCall.title ?? "Unknown tool",
      toolKind: params.toolCall.kind ?? "other",
      rawInput: params.toolCall.rawInput,
      options: params.options.map((opt) => ({
        optionId: opt.optionId,
        name: opt.name,
        kind: opt.kind,
      })),
    });

    const optionId = await optionIdPromise;
    return { outcome: { outcome: "selected", optionId } };
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const content = await Bun.file(params.path).text();
    return { content };
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await Bun.write(params.path, params.content);
    return {};
  }

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    const terminalId = randomUUID();

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
 * Resolves a pending permission request by its request ID.
 */
export function resolvePermission(
  pendingPermissions: Map<string, { resolve: (optionId: string) => void }>,
  requestId: string,
  optionId: string,
): void {
  const pending = pendingPermissions.get(requestId);
  if (pending) {
    pending.resolve(optionId);
    pendingPermissions.delete(requestId);
  }
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

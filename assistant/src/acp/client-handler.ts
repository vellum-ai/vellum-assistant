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

      case "agent_thought_chunk": {
        const text = extractText(update.content);
        this.sendToVellum({
          type: "acp_session_update",
          acpSessionId: this.acpSessionId,
          updateType: "agent_thought_chunk",
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
        // Other update types (available_commands_update, current_mode_update,
        // config_option_update, session_info_update, usage_update) are not
        // forwarded to Vellum.
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
    const toolTitle = params.toolCall.title ?? "Unknown tool";
    const toolKind = params.toolCall.kind ?? "other";
    const options = params.options;

    log.info(
      {
        acpSessionId: this.acpSessionId,
        toolTitle,
        toolKind,
        optionCount: options.length,
      },
      "ACP permission requested — auto-allowing",
    );

    // Auto-allow ACP permission requests — suppress deterministic approval
    // cards and follow the non-host auto-allow contract.
    const allowOptionId = findAllowOptionId(options);
    return {
      outcome: allowOptionId
        ? { outcome: "selected", optionId: allowOptionId }
        : { outcome: "cancelled" },
    };
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

function findAllowOptionId(
  options: Array<{ optionId: string; kind: string }>,
): string | undefined {
  return (
    options.find((o) => o.kind === "allow_once")?.optionId ??
    options.find((o) => o.kind === "allow_always")?.optionId
  );
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

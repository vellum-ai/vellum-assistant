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
  ToolCallLocation,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AcpSessionUpdate } from "../daemon/message-types/acp.js";
import { redactJsonStringLeaves } from "../security/redact-json.js";
import { redactSensitiveFields } from "../security/redaction.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("acp:client-handler");

// Field-name redaction across object/array shapes (covers top-level arrays;
// redactSensitiveFields handles the nested recursion within objects).
function redactSensitivePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitivePayload);
  if (value !== null && typeof value === "object") {
    return redactSensitiveFields(value as Record<string, unknown>);
  }
  return value;
}

// The execute kind's title is the command line, which can carry a literal
// credential — scrub shaped secrets before forwarding/persisting it.
function redactTitle(title: string | null | undefined): string | undefined {
  if (title == null) return undefined;
  return redactSecrets(title);
}

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
  private suppressForwarding = false;
  /** Monotonic ordering counter; advanced only on forwarded updates. */
  private lastSeq = 0;
  /** Tracks pending ACP permission requestIds for cleanup on session close. */
  readonly pendingRequestIds = new Set<string>();

  /** Returns the full agent response text accumulated from agent_message_chunk events. */
  get responseText(): string {
    return this.accumulatedText;
  }

  /**
   * Advances the seq counter to at least `maxSeq` so updates forwarded by a
   * handler created for a resumed session continue strictly increasing past
   * any seq already persisted. Ignores non-finite or smaller values.
   */
  seedSeq(maxSeq: number): void {
    if (Number.isFinite(maxSeq) && maxSeq > this.lastSeq) {
      this.lastSeq = maxSeq;
    }
  }

  constructor(
    private readonly acpSessionId: string,
    private readonly sendToVellum: (msg: ServerMessage) => void,
    private readonly parentConversationId: string,
  ) {}

  /** Forwards an update to Vellum, stamping a contiguous per-session `seq`. */
  private forwardUpdate(
    update: Omit<AcpSessionUpdate, "type" | "acpSessionId" | "seq">,
  ): void {
    this.sendToVellum({
      type: "acp_session_update",
      acpSessionId: this.acpSessionId,
      seq: ++this.lastSeq,
      ...update,
    });
  }

  /**
   * Cap a raw tool payload so a single large one can't evict real transcript
   * events from the bounded session buffer (and the persisted event log). Small
   * payloads pass through unchanged; oversize ones become a short marker string.
   */
  private capRawPayload(value: unknown): unknown {
    const CAP_BYTES = 16 * 1024;
    if (value === undefined) return undefined;
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? "";
    } catch {
      return "[raw payload omitted: not serializable]";
    }
    if (serialized.length <= CAP_BYTES) return value;
    return `[raw payload omitted: ${serialized.length} bytes exceeds ${CAP_BYTES}-byte cap]`;
  }

  /**
   * Redact secrets, then cap size, before forwarding — so a leaked credential
   * never reaches the SSE stream, the session buffer, or persisted
   * `event_log_json`. Two passes: `redactSensitivePayload` blanks values under
   * credential-named keys (value-only scanning misses these once JSON-leaf
   * isolation drops the key↔value context), then `redactJsonStringLeaves`
   * catches shape-based secrets anywhere in the payload. `undefined` passes
   * straight through.
   */
  private prepareRawPayload(value: unknown): unknown {
    if (value === undefined) return undefined;
    const redacted = redactJsonStringLeaves(
      redactSensitivePayload(value),
    ).value;
    return this.capRawPayload(redacted);
  }

  /**
   * Begins suppressing session updates from being forwarded to Vellum.
   *
   * Per the ACP spec, `session/load` replays the entire conversation history
   * as `session/update` notifications before the load response resolves. The
   * parent conversation already received those events during the original
   * run, so re-forwarding them would duplicate them into the conversation and
   * the ring buffer. Callers wrap `loadSession` in
   * beginReplaySuppression()/endReplaySuppression() to drop the replay.
   * `session/resume` performs no replay, which is why it is preferred when
   * the agent supports it.
   */
  beginReplaySuppression(): void {
    this.suppressForwarding = true;
  }

  /** Ends replay suppression; subsequent updates flow normally. */
  endReplaySuppression(): void {
    this.suppressForwarding = false;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    if (this.suppressForwarding) {
      log.debug(
        { acpSessionId: this.acpSessionId, updateType: update.sessionUpdate },
        "Dropping replayed session update during suppression",
      );
      return;
    }

    log.debug(
      { acpSessionId: this.acpSessionId, updateType: update.sessionUpdate },
      "ACP session update received",
    );

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractText(update.content);
        this.accumulatedText += text;
        this.forwardUpdate({
          updateType: "agent_message_chunk",
          content: text,
          messageId: update.messageId ?? undefined,
        });
        break;
      }

      case "agent_thought_chunk": {
        const text = extractText(update.content);
        this.forwardUpdate({
          updateType: "agent_thought_chunk",
          content: text,
          messageId: update.messageId ?? undefined,
        });
        break;
      }

      case "user_message_chunk": {
        const text = extractText(update.content);
        this.forwardUpdate({
          updateType: "user_message_chunk",
          content: text,
          messageId: update.messageId ?? undefined,
        });
        break;
      }

      case "tool_call": {
        this.forwardUpdate({
          updateType: "tool_call",
          toolCallId: update.toolCallId,
          toolTitle: redactTitle(update.title),
          toolKind: update.kind,
          toolStatus: update.status,
          // An agent may put output/diff on the initial tool_call and never
          // follow up with an update; forward it like the update branch so the
          // chat/file-diff UI has content to render.
          content: update.content ? JSON.stringify(update.content) : undefined,
          // rawInput/rawOutput are unknown-shaped; forward them structurally
          // (the SSE layer serializes the message) after redacting secrets and
          // capping size — so leaked credentials never persist and a single
          // large payload can't evict real transcript events from the buffer.
          rawInput: this.prepareRawPayload(update.rawInput),
          rawOutput: this.prepareRawPayload(update.rawOutput),
          locations: mapLocations(update.locations),
        });
        break;
      }

      case "tool_call_update": {
        this.forwardUpdate({
          updateType: "tool_call_update",
          toolCallId: update.toolCallId,
          toolTitle: redactTitle(update.title),
          toolKind: update.kind ?? undefined,
          toolStatus: update.status ?? undefined,
          content: update.content ? JSON.stringify(update.content) : undefined,
          rawInput: this.prepareRawPayload(update.rawInput),
          rawOutput: this.prepareRawPayload(update.rawOutput),
          locations: mapLocations(update.locations),
        });
        break;
      }

      case "plan": {
        this.forwardUpdate({
          updateType: "plan",
          content: JSON.stringify(update.entries),
        });
        break;
      }

      case "usage_update": {
        // Side gauge of context-window usage; no seq (not part of the
        // ordered timeline). UNSTABLE: cost may be absent.
        this.sendToVellum({
          type: "acp_session_usage",
          acpSessionId: this.acpSessionId,
          usedTokens: update.used,
          contextSize: update.size,
          costAmount: update.cost?.amount,
          costCurrency: update.cost?.currency,
        });
        break;
      }

      default: {
        // Other update types (available_commands_update, current_mode_update,
        // config_option_update, session_info_update) are not forwarded to
        // Vellum.
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

/**
 * Normalize ACP tool-call locations into the SSE update's `locations` shape.
 *
 * The ACP `tool_call_update.locations` field is tri-state:
 * - `undefined`/absent → no change; omit the field so web preserves prior locations.
 * - `null` → explicit clear; forward `[]` (web clears its locations on an empty array).
 * - an array → replace with the mapped locations.
 */
function mapLocations(
  locations: ToolCallLocation[] | null | undefined,
): Array<{ path: string; line?: number }> | undefined {
  if (locations === undefined) return undefined;
  if (locations === null) return [];
  return locations.map((l) => ({ path: l.path, line: l.line ?? undefined }));
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

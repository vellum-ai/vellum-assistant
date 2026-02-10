import * as net from "node:net";
import { once } from "node:events";

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const USER_MESSAGE_TIMEOUT_MS = 120000;
const MAX_BUFFER_BYTES = 1024 * 1024;

type DaemonMessage = Record<string, unknown> & { type: string };

export type LocalDaemonErrorCode =
  | "UNREACHABLE"
  | "TIMEOUT"
  | "DAEMON_ERROR"
  | "SESSION_NOT_FOUND"
  | "BUSY"
  | "PROTOCOL_ERROR";

export class LocalDaemonError extends Error {
  constructor(
    public readonly code: LocalDaemonErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LocalDaemonError";
  }
}

export interface DaemonSessionInfo {
  sessionId: string;
  title: string;
}

export interface DaemonHistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface DaemonUsageUpdate {
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface DaemonUserMessageResult {
  assistantText: string;
  usage: DaemonUsageUpdate | null;
}

interface Waiter {
  predicate: (msg: DaemonMessage) => boolean;
  resolve: (msg: DaemonMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asDaemonMessage(value: unknown): DaemonMessage | null {
  if (!isObject(value)) return null;
  const type = value.type;
  if (typeof type !== "string") return null;
  return value as DaemonMessage;
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

function classifyDaemonError(message: string): LocalDaemonError {
  if (/already processing a message/i.test(message)) {
    return new LocalDaemonError("BUSY", message);
  }
  if (/session .* not found/i.test(message)) {
    return new LocalDaemonError("SESSION_NOT_FOUND", message);
  }
  return new LocalDaemonError("DAEMON_ERROR", message);
}

function toLocalDaemonError(
  error: unknown,
  fallbackMessage: string
): LocalDaemonError {
  if (error instanceof LocalDaemonError) {
    return error;
  }

  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (
      nodeError.code === "ENOENT" ||
      nodeError.code === "ECONNREFUSED" ||
      nodeError.code === "EACCES" ||
      nodeError.code === "EPERM"
    ) {
      return new LocalDaemonError("UNREACHABLE", error.message);
    }
    return new LocalDaemonError("DAEMON_ERROR", error.message);
  }

  return new LocalDaemonError("DAEMON_ERROR", fallbackMessage);
}

function parseSessionInfo(msg: DaemonMessage): DaemonSessionInfo {
  const sessionId = msg.sessionId;
  const title = msg.title;
  if (typeof sessionId !== "string" || typeof title !== "string") {
    throw new LocalDaemonError(
      "PROTOCOL_ERROR",
      "Daemon returned an invalid session_info payload"
    );
  }
  return { sessionId, title };
}

export class LocalDaemonClient {
  private readonly socket: net.Socket;
  private readonly socketPath: string;
  private closed = false;
  private closeError: LocalDaemonError | null = null;
  private buffer = "";
  private queue: DaemonMessage[] = [];
  private waiters: Waiter[] = [];

  private constructor(socket: net.Socket, socketPath: string) {
    this.socket = socket;
    this.socketPath = socketPath;

    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleSocketData(chunk));
    this.socket.on("error", (error) => this.handleSocketError(error));
    this.socket.on("close", () => this.handleSocketClose());
  }

  static async connect(
    socketPath: string,
    options?: { connectTimeoutMs?: number; handshakeTimeoutMs?: number }
  ): Promise<LocalDaemonClient> {
    const connectTimeoutMs =
      options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const handshakeTimeoutMs =
      options?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    const socket = net.createConnection(socketPath);
    const client = new LocalDaemonClient(socket, socketPath);

    await waitForSocketConnect(socket, socketPath, connectTimeoutMs);

    const handshakeMessage = await client.waitFor(
      (msg) => msg.type === "session_info" || msg.type === "error",
      handshakeTimeoutMs
    );

    if (handshakeMessage.type === "error") {
      const daemonMessage =
        typeof handshakeMessage.message === "string"
          ? handshakeMessage.message
          : "Daemon handshake failed";
      client.close();
      throw classifyDaemonError(daemonMessage);
    }

    return client;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error =
      this.closeError ??
      new LocalDaemonError("UNREACHABLE", "Local daemon connection closed");
    this.rejectAllWaiters(error);
    this.socket.destroy();
  }

  async ping(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    this.send({ type: "ping" });
    const response = await this.waitFor(
      (msg) => msg.type === "pong" || msg.type === "error",
      timeoutMs
    );

    if (response.type === "error") {
      const message =
        typeof response.message === "string"
          ? response.message
          : "Daemon ping failed";
      throw classifyDaemonError(message);
    }
  }

  async createSession(
    title?: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<DaemonSessionInfo> {
    this.send({
      type: "session_create",
      ...(title ? { title } : {}),
    });

    const response = await this.waitFor(
      (msg) => msg.type === "session_info" || msg.type === "error",
      timeoutMs
    );

    if (response.type === "error") {
      const message =
        typeof response.message === "string"
          ? response.message
          : "Failed to create daemon session";
      throw classifyDaemonError(message);
    }

    return parseSessionInfo(response);
  }

  async switchSession(
    sessionId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<DaemonSessionInfo> {
    this.send({
      type: "session_switch",
      sessionId,
    });

    const response = await this.waitFor(
      (msg) => msg.type === "session_info" || msg.type === "error",
      timeoutMs
    );

    if (response.type === "error") {
      const message =
        typeof response.message === "string"
          ? response.message
          : `Failed to switch daemon session ${sessionId}`;
      throw classifyDaemonError(message);
    }

    return parseSessionInfo(response);
  }

  async getHistory(
    sessionId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<DaemonHistoryMessage[]> {
    this.send({
      type: "history_request",
      sessionId,
    });

    const response = await this.waitFor(
      (msg) => msg.type === "history_response" || msg.type === "error",
      timeoutMs
    );

    if (response.type === "error") {
      const message =
        typeof response.message === "string"
          ? response.message
          : `Failed to fetch history for session ${sessionId}`;
      throw classifyDaemonError(message);
    }

    const rawMessages = Array.isArray(response.messages) ? response.messages : [];

    return rawMessages
      .map((entry): DaemonHistoryMessage | null => {
        if (!isObject(entry)) return null;
        const role = entry.role;
        const text = entry.text;
        const timestamp = entry.timestamp;
        if (
          (role !== "user" && role !== "assistant") ||
          typeof text !== "string" ||
          typeof timestamp !== "number"
        ) {
          return null;
        }
        return {
          role,
          text,
          timestamp,
        };
      })
      .filter((entry): entry is DaemonHistoryMessage => entry !== null);
  }

  async sendUserMessage(
    sessionId: string,
    content: string,
    timeoutMs = USER_MESSAGE_TIMEOUT_MS
  ): Promise<DaemonUserMessageResult> {
    this.send({
      type: "user_message",
      sessionId,
      content,
    });

    let assistantText = "";
    let usage: DaemonUsageUpdate | null = null;

    while (true) {
      const message = await this.waitFor(() => true, timeoutMs);

      switch (message.type) {
        case "assistant_text_delta": {
          if (typeof message.text === "string") {
            assistantText += message.text;
          }
          break;
        }
        case "usage_update": {
          const parsed = parseUsageUpdate(message);
          if (parsed) {
            usage = parsed;
          }
          break;
        }
        case "message_complete":
          return {
            assistantText: assistantText.trim(),
            usage,
          };
        case "error": {
          const daemonMessage =
            typeof message.message === "string"
              ? message.message
              : "Daemon failed to process message";
          throw classifyDaemonError(daemonMessage);
        }
        case "generation_cancelled":
          throw new LocalDaemonError(
            "DAEMON_ERROR",
            "Daemon cancelled message generation"
          );
        default:
          break;
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) {
      throw new LocalDaemonError(
        "UNREACHABLE",
        `Socket is closed (${this.socketPath})`
      );
    }
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private waitFor(
    predicate: (msg: DaemonMessage) => boolean,
    timeoutMs: number
  ): Promise<DaemonMessage> {
    if (this.closed) {
      throw this.closeError ??
        new LocalDaemonError("UNREACHABLE", "Daemon connection is closed");
    }

    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const [message] = this.queue.splice(queuedIndex, 1);
      return Promise.resolve(message);
    }

    return new Promise<DaemonMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== entry);
        reject(
          new LocalDaemonError(
            "TIMEOUT",
            `Timed out waiting for daemon response after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      const entry: Waiter = {
        predicate,
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };

      this.waiters.push(entry);
      this.flushWaiters();
    });
  }

  private handleSocketData(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    if (Buffer.byteLength(this.buffer, "utf8") > MAX_BUFFER_BYTES) {
      const error = new LocalDaemonError(
        "PROTOCOL_ERROR",
        "Daemon IPC buffer exceeded maximum size"
      );
      this.closeError = error;
      this.close();
      this.rejectAllWaiters(error);
      return;
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const message = asDaemonMessage(parsed);
      if (!message) continue;

      if (message.type === "confirmation_request") {
        this.autoDenyConfirmation(message);
        continue;
      }

      this.queue.push(message);
    }

    this.flushWaiters();
  }

  private autoDenyConfirmation(message: DaemonMessage): void {
    const requestId = message.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return;
    }

    try {
      this.send({
        type: "confirmation_response",
        requestId,
        decision: "deny",
      });
    } catch {
      // Best effort only.
    }
  }

  private flushWaiters(): void {
    if (this.waiters.length === 0 || this.queue.length === 0) {
      return;
    }

    const pending = [...this.waiters];
    for (const waiter of pending) {
      const matchIndex = this.queue.findIndex(waiter.predicate);
      if (matchIndex < 0) continue;

      const [message] = this.queue.splice(matchIndex, 1);
      this.waiters = this.waiters.filter((entry) => entry !== waiter);
      waiter.resolve(message);
    }
  }

  private handleSocketError(error: Error): void {
    if (this.closed) return;
    this.closeError = toLocalDaemonError(error, "Local daemon socket error");
  }

  private handleSocketClose(): void {
    if (this.closed) return;
    this.closed = true;
    const error =
      this.closeError ??
      new LocalDaemonError("UNREACHABLE", "Local daemon socket closed");
    this.rejectAllWaiters(error);
  }

  private rejectAllWaiters(error: LocalDaemonError): void {
    const pending = [...this.waiters];
    this.waiters = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

function parseUsageUpdate(message: DaemonMessage): DaemonUsageUpdate | null {
  const inputTokens = message.inputTokens;
  const outputTokens = message.outputTokens;
  const totalInputTokens = message.totalInputTokens;
  const totalOutputTokens = message.totalOutputTokens;
  const estimatedCost = message.estimatedCost;
  const model = message.model;

  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalInputTokens !== "number" ||
    typeof totalOutputTokens !== "number" ||
    typeof estimatedCost !== "number" ||
    typeof model !== "string"
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalInputTokens,
    totalOutputTokens,
    estimatedCost,
    model,
  };
}

async function waitForSocketConnect(
  socket: net.Socket,
  socketPath: string,
  timeoutMs: number
): Promise<void> {
  const timeout = setTimeout(() => {
    socket.destroy(
      new LocalDaemonError(
        "TIMEOUT",
        `Timed out connecting to daemon socket ${socketPath}`
      )
    );
  }, timeoutMs);

  try {
    if (socket.readyState === "open") {
      return;
    }
    await once(socket, "connect");
  } catch (error: unknown) {
    throw toLocalDaemonError(
      error,
      `Failed connecting to daemon socket ${socketPath}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function isLocalDaemonErrorWithCode(
  error: unknown,
  code: LocalDaemonErrorCode
): boolean {
  return error instanceof LocalDaemonError && error.code === code;
}

export function describeLocalDaemonError(error: unknown): string {
  if (error instanceof LocalDaemonError) {
    return error.message;
  }
  return getErrorMessage(error);
}

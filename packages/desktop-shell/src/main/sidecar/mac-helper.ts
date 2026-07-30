import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";

import {
  SidecarSupervisor,
  type SidecarState,
} from "./supervisor";

export type MacHelperState = SidecarState;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

const JSON_RPC_ID_SCHEMA = z.union([z.string(), z.number(), z.null()]);

const JSON_RPC_ERROR_SCHEMA = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const JSON_RPC_NOTIFICATION_SCHEMA = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const JSON_RPC_SUCCESS_RESPONSE_SCHEMA = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JSON_RPC_ID_SCHEMA,
    result: z.unknown().optional(),
  })
  .strict();

const JSON_RPC_ERROR_RESPONSE_SCHEMA = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JSON_RPC_ID_SCHEMA,
    error: JSON_RPC_ERROR_SCHEMA,
  })
  .strict();

const JSON_RPC_FRAME_SCHEMA = z.union([
  JSON_RPC_NOTIFICATION_SCHEMA,
  JSON_RPC_SUCCESS_RESPONSE_SCHEMA,
  JSON_RPC_ERROR_RESPONSE_SCHEMA,
]);

export type JsonRpcId = z.infer<typeof JSON_RPC_ID_SCHEMA>;
export type JsonRpcNotification = z.infer<
  typeof JSON_RPC_NOTIFICATION_SCHEMA
>;
export type JsonRpcErrorPayload = z.infer<typeof JSON_RPC_ERROR_SCHEMA>;

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingStream = {
  queue: AsyncQueue<unknown>;
  timeout: ReturnType<typeof setTimeout>;
};

type NotificationSubscription = {
  schema: z.ZodType;
  listener: (params: unknown) => void;
};

type StreamSubscription = {
  method: string;
  schema: z.ZodType;
  matches?: (notification: JsonRpcNotification) => boolean;
  queue: AsyncQueue<unknown>;
};

export interface MacHelperClientOptions {
  name: string;
  resolveExecutablePath: () => string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  responseTimeoutMs?: number;
  spawnArgs?: string[];
  /** Extra environment merged over process.env for the spawned helper. */
  spawnEnv?: Record<string, string>;
  platform?: NodeJS.Platform;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  stableResetMs?: number;
  circuitCrashCount?: number;
  circuitWindowMs?: number;
}

export interface MacHelperStreamOptions<T> {
  notificationMethod: string;
  notificationSchema: z.ZodType<T>;
  matches?: (notification: JsonRpcNotification) => boolean;
}

export class JsonRpcHelperError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcErrorPayload) {
    super(error.message);
    this.name = "JsonRpcHelperError";
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 2_000;

export class MacHelperClient {
  private readonly name: string;
  private readonly resolveExecutablePath: () => string;
  private readonly logger: MacHelperClientOptions["logger"];
  private readonly responseTimeoutMs: number;
  private readonly spawnArgs: string[];
  private readonly spawnEnv?: Record<string, string>;
  private readonly platform: NodeJS.Platform;
  private readonly supervisor: SidecarSupervisor;
  private stdoutBuffer = "";
  private nextId = 1;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private readonly notificationSubscriptions = new Map<
    string,
    Set<NotificationSubscription>
  >();
  private readonly streamSubscriptions = new Set<StreamSubscription>();

  constructor(options: MacHelperClientOptions) {
    this.name = options.name;
    this.resolveExecutablePath = options.resolveExecutablePath;
    this.logger = options.logger;
    this.responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.spawnArgs = options.spawnArgs ?? [];
    if (options.spawnEnv) this.spawnEnv = options.spawnEnv;
    this.platform = options.platform ?? process.platform;
    this.supervisor = new SidecarSupervisor({
      name: this.name,
      logger: this.logger,
      spawn: () => this.spawnChild(),
      onStart: (child) => this.attachChild(child),
      onExit: (reason) => this.handleExit(reason),
      initialBackoffMs: options.initialBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
      stableResetMs: options.stableResetMs,
      circuitCrashCount: options.circuitCrashCount,
      circuitWindowMs: options.circuitWindowMs,
    });
  }

  getState(): MacHelperState {
    return this.supervisor.getState();
  }

  onState(listener: (state: MacHelperState) => void): () => void {
    return this.supervisor.onState(listener);
  }

  onNotification<T>(
    method: string,
    schema: z.ZodType<T>,
    listener: (params: T) => void,
  ): () => void {
    const subscription: NotificationSubscription = {
      schema,
      listener: (params) => listener(params as T),
    };
    const subscriptions =
      this.notificationSubscriptions.get(method) ??
      new Set<NotificationSubscription>();
    subscriptions.add(subscription);
    this.notificationSubscriptions.set(method, subscriptions);

    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
        this.notificationSubscriptions.delete(method);
      }
    };
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(String(id));
        reject(new Error(`${this.name} did not respond`));
      }, this.responseTimeoutMs);
      timeout.unref?.();

      this.pendingCalls.set(String(id), { resolve, reject, timeout });
      try {
        this.writeFrame(
          child,
          {
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          },
          (err) => {
            if (!err) return;
            this.rejectPendingCall(
              id,
              new Error(`${this.name} write failed: ${err.message}`),
            );
          },
        );
      } catch (err) {
        this.rejectPendingCall(
          id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  async *stream<T>(
    method: string,
    params: unknown,
    options: MacHelperStreamOptions<T>,
  ): AsyncIterable<T> {
    const child = this.ensureChild();
    const id = this.nextId++;
    const queue = new AsyncQueue<unknown>();
    const streamSubscription: StreamSubscription = {
      method: options.notificationMethod,
      schema: options.notificationSchema,
      matches: options.matches,
      queue,
    };
    this.streamSubscriptions.add(streamSubscription);

    const timeout = setTimeout(() => {
      this.pendingStreams.delete(String(id));
      this.streamSubscriptions.delete(streamSubscription);
      queue.fail(new Error(`${this.name} did not finish ${method}`));
    }, this.responseTimeoutMs);
    timeout.unref?.();
    this.pendingStreams.set(String(id), { queue, timeout });

    try {
      this.writeFrame(child, {
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      for await (const frame of queue) {
        yield frame as T;
      }
    } finally {
      clearTimeout(timeout);
      this.pendingStreams.delete(String(id));
      this.streamSubscriptions.delete(streamSubscription);
    }
  }

  retry(): MacHelperState {
    this.clearPending(new Error(`${this.name} restarted`));
    return this.supervisor.retry();
  }

  shutdown(gracefulRequest?: { method: string; params?: unknown }): void {
    const child = this.supervisor.currentChild();
    if (child) {
      try {
        if (gracefulRequest) {
          this.writeFrame(child, {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: gracefulRequest.method,
            ...(gracefulRequest.params === undefined
              ? {}
              : { params: gracefulRequest.params }),
          });
        }
        child.stdin.end();
      } catch {
        // The process may already be gone. The supervisor owns final cleanup.
      }
    }
    this.supervisor.stop({ reason: "app quit" });
  }

  resetForTesting(): void {
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.clearPending(new Error(`${this.name} reset`));
    this.notificationSubscriptions.clear();
    this.streamSubscriptions.clear();
    this.supervisor.resetForTesting();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.platform !== "darwin") {
      throw new Error(`${this.name} is only available on macOS`);
    }

    const child = this.supervisor.ensureRunning();
    if (!child) {
      throw new Error(`${this.name} is not available`);
    }
    return child;
  }

  private spawnChild(): ChildProcessWithoutNullStreams {
    const helperPath = this.resolveExecutablePath();
    if (!existsSync(helperPath)) {
      throw new Error(`executable not found at ${helperPath}`);
    }
    return spawn(helperPath, this.spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.spawnEnv
        ? { ...process.env, ...this.spawnEnv }
        : undefined,
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) this.logger.warn(`[${this.name}] ${line}`);
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger.warn(`[${this.name}] ignored invalid JSON: ${line}`);
      return;
    }

    const envelope = JSON_RPC_FRAME_SCHEMA.safeParse(parsed);
    if (!envelope.success) {
      this.logger.warn(`[${this.name}] ignored invalid envelope: ${line}`);
      return;
    }

    const message = envelope.data;
    if ("method" in message) {
      this.handleNotification(message);
      return;
    }

    if ("error" in message) {
      const error = new JsonRpcHelperError(message.error);
      this.rejectPendingCall(message.id, error);
      this.failPendingStream(message.id, error);
    } else {
      this.resolvePendingCall(message.id, message.result);
      this.finishPendingStream(message.id);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const subscriptions = this.notificationSubscriptions.get(
      notification.method,
    );
    if (subscriptions) {
      for (const subscription of subscriptions) {
        const parsed = subscription.schema.safeParse(notification.params);
        if (parsed.success) {
          subscription.listener(parsed.data);
        } else {
          this.logger.warn(
            `[${this.name}] ignored invalid ${notification.method} params`,
          );
        }
      }
    }

    for (const stream of this.streamSubscriptions) {
      if (stream.method !== notification.method) continue;
      if (stream.matches && !stream.matches(notification)) continue;
      const parsed = stream.schema.safeParse(notification.params);
      if (parsed.success) {
        stream.queue.push(parsed.data);
      } else {
        stream.queue.fail(
          new Error(`${this.name} returned invalid ${notification.method}`),
        );
      }
    }
  }

  private writeFrame(
    child: ChildProcessWithoutNullStreams,
    frame: Record<string, unknown>,
    callback?: (err?: Error | null) => void,
  ): void {
    const line = JSON.stringify(frame);
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(`${this.name} frame contained raw newline`);
    }
    child.stdin.write(`${line}\n`, callback);
  }

  private resolvePendingCall(id: JsonRpcId, result: unknown): void {
    if (id === null) return;
    const pending = this.pendingCalls.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCalls.delete(String(id));
    pending.resolve(result);
  }

  private rejectPendingCall(id: JsonRpcId, error: Error): void {
    if (id === null) return;
    const pending = this.pendingCalls.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCalls.delete(String(id));
    pending.reject(error);
  }

  private finishPendingStream(id: JsonRpcId): void {
    if (id === null) return;
    const pending = this.pendingStreams.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingStreams.delete(String(id));
    pending.queue.end();
  }

  private failPendingStream(id: JsonRpcId, error: Error): void {
    if (id === null) return;
    const pending = this.pendingStreams.get(String(id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingStreams.delete(String(id));
    pending.queue.fail(error);
  }

  private handleExit(reason: string): void {
    this.stdoutBuffer = "";
    this.clearPending(
      new Error(`${this.name} exited before response (${reason})`),
    );
  }

  private clearPending(error: Error): void {
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingCalls.clear();

    for (const pending of this.pendingStreams.values()) {
      clearTimeout(pending.timeout);
      pending.queue.fail(error);
    }
    this.pendingStreams.clear();
    this.streamSubscriptions.clear();
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure);
        if (this.values.length > 0) {
          return Promise.resolve({
            value: this.values.shift() as T,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

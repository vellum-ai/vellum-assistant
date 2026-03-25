import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { formatShellOutput } from "../tools/shared/shell-output.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("host-bash-proxy");

interface PendingRequest {
  resolve: (result: ToolExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutSec: number;
}

export class HostBashProxy {
  private pending = new Map<string, PendingRequest>();
  private sendToClient: (msg: ServerMessage) => void;
  private onInternalResolve?: (requestId: string) => void;
  private clientConnected = false;

  constructor(
    sendToClient: (msg: ServerMessage) => void,
    onInternalResolve?: (requestId: string) => void,
  ) {
    this.sendToClient = sendToClient;
    this.onInternalResolve = onInternalResolve;
  }

  updateSender(
    sendToClient: (msg: ServerMessage) => void,
    clientConnected: boolean,
  ): void {
    this.sendToClient = sendToClient;
    this.clientConnected = clientConnected;
  }

  request(
    input: {
      command: string;
      working_dir?: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    },
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      const result = formatShellOutput("", "Aborted", null, false, 0);
      return Promise.resolve(result);
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const shellMaxTimeoutSec = getConfig().timeouts.shellMaxTimeoutSec;
      const timeoutSec = input.timeout_seconds ?? shellMaxTimeoutSec;
      // Proxy timeout: slightly after client-side timeout, but before executor's outer timeout
      const proxyTimeoutSec = timeoutSec + 3;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.onInternalResolve?.(requestId);
        log.warn(
          { requestId, command: input.command },
          "Host bash proxy request timed out",
        );
        resolve(
          formatShellOutput(
            "",
            "Host bash proxy timed out waiting for client response",
            null,
            true,
            timeoutSec,
          ),
        );
      }, proxyTimeoutSec * 1000);

      this.pending.set(requestId, { resolve, reject, timer, timeoutSec });

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            this.onInternalResolve?.(requestId);
            this.sendToClient({
              type: "host_bash_cancel",
              requestId,
            } as ServerMessage);
            resolve(formatShellOutput("", "Aborted", null, false, 0));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.sendToClient({
        type: "host_bash_request",
        requestId,
        conversationId,
        command: input.command,
        working_dir: input.working_dir,
        timeout_seconds: input.timeout_seconds,
        ...(input.env && Object.keys(input.env).length > 0
          ? { env: input.env }
          : {}),
      } as ServerMessage);
    });
  }

  resolve(
    requestId: string,
    response: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, "No pending host bash request for response");
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const result = formatShellOutput(
      response.stdout,
      response.stderr,
      response.exitCode,
      response.timedOut,
      entry.timeoutSec,
    );
    entry.resolve(result);
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  isAvailable(): boolean {
    return this.clientConnected;
  }

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.onInternalResolve?.(requestId);
      this.sendToClient({
        type: "host_bash_cancel",
        requestId,
      } as ServerMessage);
      entry.reject(
        new AssistantError(
          "Host bash proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
    this.pending.clear();
  }
}

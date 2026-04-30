import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { assistantEventHub, broadcastMessage } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
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
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort: () => void;
}

export class HostBashProxy {
  private static _instance: HostBashProxy | null = null;

  /**
   * Lazily-initialized singleton. Availability of an actual desktop
   * connection is checked at send time via the assistant event hub,
   * not at construction time.
   */
  static get instance(): HostBashProxy {
    if (!HostBashProxy._instance) {
      log.info("Creating singleton HostBashProxy");
      HostBashProxy._instance = new HostBashProxy();
    }
    return HostBashProxy._instance;
  }

  /** Dispose the singleton. Called during graceful shutdown. */
  static disposeInstance(): void {
    if (HostBashProxy._instance) {
      HostBashProxy._instance.dispose();
      HostBashProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostBashProxy._instance = null;
  }

  private pending = new Map<string, PendingRequest>();

  /**
   * Whether a client with `host_bash` capability is connected.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_bash") != null
    );
  }

  private send(msg: ServerMessage): void {
    broadcastMessage(msg);
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

      // Declared up-front so onAbort (defined before detachAbort is assigned)
      // can close over a stable reference once it's wired below.
      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
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

      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            detachAbort();
            pendingInteractions.resolve(requestId);
            try {
              this.send({
                type: "host_bash_cancel",
                requestId,
              } as ServerMessage);
            } catch {
              // Best-effort cancel notification — connection may already be closed.
            }
            resolve(formatShellOutput("", "Aborted", null, false, 0));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        timeoutSec,
        detachAbort,
      });

      try {
        this.send({
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
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        detachAbort();
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, command: input.command, err },
          "Host bash proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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
    entry.detachAbort();
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

  dispose(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.detachAbort();
      pendingInteractions.resolve(requestId);
      try {
        this.send({
          type: "host_bash_cancel",
          requestId,
        } as ServerMessage);
      } catch {
        // Best-effort cancel notification — connection may already be closed.
      }
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

import { v4 as uuid } from "uuid";

import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { readImageBase64 } from "../tools/shared/filesystem/image-read.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { HostFileRequest } from "./message-types/host-file.js";

/** Distributive omit that preserves union variant fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Clean input type for callers — transport envelope fields are added by the proxy. */
export type HostFileInput = DistributiveOmit<
  HostFileRequest,
  "type" | "requestId" | "conversationId"
>;

const log = getLogger("host-file-proxy");

export class HostFileProxy {
  private static _instance: HostFileProxy | null = null;

  /**
   * Lazily-initialized singleton. Availability of an actual desktop
   * connection is checked at send time via the assistant event hub,
   * not at construction time.
   */
  static get instance(): HostFileProxy {
    if (!HostFileProxy._instance) {
      log.info("Creating singleton HostFileProxy");
      HostFileProxy._instance = new HostFileProxy();
    }
    return HostFileProxy._instance;
  }

  /** Dispose the singleton. Called during graceful shutdown. */
  static disposeInstance(): void {
    if (HostFileProxy._instance) {
      HostFileProxy._instance.dispose();
      HostFileProxy._instance = null;
    }
  }

  /** For tests. */
  static reset(): void {
    HostFileProxy._instance = null;
  }

  /**
   * Whether a client with `host_file` capability is connected.
   * Note: host_file covers both file operations and transfers.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_file") != null
    );
  }

  request(
    input: HostFileInput,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return Promise.resolve({ content: "Aborted", isError: true });
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const timeoutSec = 30;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, operation: input.operation },
          "Host file proxy request timed out",
        );
        resolve({
          content: "Host file proxy timed out waiting for client response",
          isError: true,
        });
      }, timeoutSec * 1000);

      if (signal) {
        const onAbort = () => {
          if (pendingInteractions.get(requestId)) {
            pendingInteractions.resolve(requestId);
            try {
              broadcastMessage({
                type: "host_file_cancel",
                requestId,
                conversationId,
              });
            } catch {
              // Best-effort cancel notification
            }
            resolve({ content: "Aborted", isError: true });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      pendingInteractions.register(requestId, {
        conversationId,
        kind: "host_file",
        rpcResolve: resolve,
        rpcReject: reject,
        timer,
        detachAbort,
        metadata: { operation: input.operation, path: input.path },
      });

      try {
        broadcastMessage({
          ...input,
          type: "host_file_request",
          requestId,
          conversationId,
        });
      } catch (err) {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, operation: input.operation, err },
          "Host file proxy send failed",
        );
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Process a client result and resolve the RPC. Called by route handlers.
   */
  resolveResult(
    requestId: string,
    response: { content: string; isError: boolean; imageData?: string },
  ): void {
    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction?.rpcResolve) {
      log.warn({ requestId }, "No pending host file request for response");
      return;
    }
    const meta = interaction.metadata ?? {};
    if (
      meta.operation === "read" &&
      !response.isError &&
      typeof response.imageData === "string" &&
      response.imageData.length > 0
    ) {
      interaction.rpcResolve(
        readImageBase64(response.imageData, meta.path as string),
      );
      return;
    }
    interaction.rpcResolve({
      content: response.content,
      isError: response.isError,
    });
  }

  dispose(): void {
    for (const entry of pendingInteractions.getByKind("host_file")) {
      pendingInteractions.resolve(entry.requestId);
      try {
        broadcastMessage({
          type: "host_file_cancel",
          requestId: entry.requestId,
          conversationId: entry.conversationId,
        });
      } catch {
        // Best-effort cancel notification
      }
      entry.rpcReject?.(
        new AssistantError(
          "Host file proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
  }
}

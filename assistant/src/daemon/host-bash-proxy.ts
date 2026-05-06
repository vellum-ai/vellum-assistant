import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { formatShellOutput } from "../tools/shared/shell-output.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("host-bash-proxy");

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

  /**
   * Whether a client with `host_bash` capability is connected.
   */
  isAvailable(): boolean {
    return (
      assistantEventHub.getMostRecentClientByCapability("host_bash") != null
    );
  }

  request(
    input: {
      command: string;
      working_dir?: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
      targetClientId?: string;
    },
    conversationId: string,
    signal?: AbortSignal,
    // Principal ID of the actor on whose behalf this request is initiated.
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      const result = formatShellOutput("", "Aborted", null, false, 0);
      return Promise.resolve(result);
    }

    let resolvedTargetClientId: string | undefined;

    if (input.targetClientId) {
      const target = assistantEventHub.getClientById(input.targetClientId);
      if (!target || !target.capabilities.includes("host_bash")) {
        return Promise.resolve({
          content: `Error: client "${input.targetClientId}" is not connected or does not support host_bash. Run \`assistant clients list --capability host_bash\` to see available clients.`,
          isError: true,
        });
      }
      resolvedTargetClientId = input.targetClientId;
    } else {
      // Auto-resolve to the unique same-user client. Reject (rather than
      // broadcast) when multiple same-user clients are connected so that
      // a single targeted-style request cannot fan out across every one
      // of the user's machines. Zero same-user matches falls through to
      // the existing untargeted code path.
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_bash",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return Promise.resolve(ambiguousSameUserError("host_bash"));
      }
      resolvedTargetClientId =
        resolved.kind === "match" ? resolved.clientId : undefined;
    }

    // Targeted requests must be bound to the same authenticated user as the
    // target client. Fail closed at request time — before pendingInteractions
    // registration and before broadcast — so a same-daemon caller cannot
    // execute on another user's connected client.
    if (resolvedTargetClientId != null) {
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId: resolvedTargetClientId,
        op: "host_bash",
      });
      if (rejection) return Promise.resolve(rejection);
    }

    const requestId = uuid();

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const shellMaxTimeoutSec = getConfig().timeouts.shellMaxTimeoutSec;
      const timeoutSec = input.timeout_seconds ?? shellMaxTimeoutSec;
      const proxyTimeoutSec = timeoutSec + 3;

      let detachAbort: () => void = () => {};

      const timer = setTimeout(() => {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, command: input.command },
          "Host bash proxy request timed out",
        );
        const timeoutMessage = resolvedTargetClientId
          ? `Host bash proxy timed out waiting for response from client ${resolvedTargetClientId}`
          : "Host bash proxy timed out waiting for client response";
        resolve(formatShellOutput("", timeoutMessage, null, true, timeoutSec));
      }, proxyTimeoutSec * 1000);

      if (signal) {
        const onAbort = () => {
          if (pendingInteractions.get(requestId)) {
            pendingInteractions.resolve(requestId);
            try {
              broadcastMessage(
                {
                  type: "host_bash_cancel",
                  requestId,
                  conversationId,
                  targetClientId: resolvedTargetClientId,
                },
                conversationId,
                { targetClientId: resolvedTargetClientId },
              );
            } catch {
              // Best-effort cancel notification
            }
            resolve(formatShellOutput("", "Aborted", null, false, 0));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      pendingInteractions.register(requestId, {
        conversationId,
        kind: "host_bash",
        rpcResolve: resolve as (v: unknown) => void,
        rpcReject: reject,
        timer,
        detachAbort,
        targetClientId: resolvedTargetClientId,
        targetActorPrincipalId:
          resolvedTargetClientId != null
            ? assistantEventHub.getActorPrincipalIdForClient(
                resolvedTargetClientId,
              )
            : undefined,
        metadata: { timeoutSec },
      });

      try {
        broadcastMessage(
          {
            type: "host_bash_request",
            requestId,
            conversationId,
            command: input.command,
            working_dir: input.working_dir,
            timeout_seconds: input.timeout_seconds,
            targetClientId: resolvedTargetClientId,
            ...(input.env && Object.keys(input.env).length > 0
              ? { env: input.env }
              : {}),
          },
          conversationId,
          { targetClientId: resolvedTargetClientId },
        );
      } catch (err) {
        pendingInteractions.resolve(requestId);
        log.warn(
          { requestId, command: input.command, err },
          "Host bash proxy send failed",
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
    response: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
  ): void {
    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction?.rpcResolve) {
      log.warn({ requestId }, "No pending host bash request for response");
      return;
    }
    const timeoutSec = (interaction.metadata?.timeoutSec as number) ?? 0;
    const result = formatShellOutput(
      response.stdout,
      response.stderr,
      response.exitCode,
      response.timedOut,
      timeoutSec,
    );
    interaction.rpcResolve(result);
  }

  dispose(): void {
    for (const entry of pendingInteractions.getByKind("host_bash")) {
      pendingInteractions.resolve(entry.requestId);
      try {
        broadcastMessage(
          {
            type: "host_bash_cancel",
            requestId: entry.requestId,
            conversationId: entry.conversationId,
            targetClientId: entry.targetClientId,
          },
          entry.conversationId,
          { targetClientId: entry.targetClientId },
        );
      } catch {
        // Best-effort cancel notification — connection may already be closed.
      }
      entry.rpcReject?.(
        new AssistantError(
          "Host bash proxy disposed",
          ErrorCode.INTERNAL_ERROR,
        ),
      );
    }
  }
}

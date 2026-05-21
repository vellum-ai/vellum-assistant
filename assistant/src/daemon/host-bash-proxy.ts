import { getConfig } from "../config/loader.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { formatShellOutput } from "../tools/shared/shell-output.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { HostProxyBase, HostProxyRequestError } from "./host-proxy-base.js";

const log = getLogger("host-bash-proxy");

export type HostBashInput = {
  command: string;
  working_dir?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  targetClientId?: string;
};

type HostBashResultPayload = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export class HostBashProxy extends HostProxyBase<
  Record<string, unknown>,
  HostBashResultPayload
> {
  private static _instance: HostBashProxy | null = null;

  constructor() {
    super({
      capabilityName: "host_bash",
      requestEventName: "host_bash_request",
      cancelEventName: "host_bash_cancel",
      resultPendingKind: "host_bash",
      disposedMessage: "Host bash proxy disposed",
    });
  }

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

  async request(
    input: HostBashInput,
    conversationId: string,
    signal?: AbortSignal,
    // Principal ID of the actor on whose behalf this request is initiated.
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return formatShellOutput("", "Aborted", null, false, 0);
    }

    let resolvedTargetClientId: string | undefined;

    if (input.targetClientId) {
      const target = assistantEventHub.getClientById(input.targetClientId);
      if (!target || !target.capabilities.includes("host_bash")) {
        return {
          content: `Error: client "${input.targetClientId}" is not connected or does not support host_bash. Run \`assistant clients list --capability host_bash\` to see available clients.`,
          isError: true,
        };
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
        return ambiguousSameUserError("host_bash");
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
      if (rejection) return rejection;
    }

    const shellMaxTimeoutSec = getConfig().timeouts.shellMaxTimeoutSec;
    const timeoutSec = input.timeout_seconds ?? shellMaxTimeoutSec;
    const proxyTimeoutMs = (timeoutSec + 3) * 1000;

    // Spread command fields at the top level of the envelope so the desktop
    // client receives the same flat message shape it has always expected.
    const extraFields: Record<string, unknown> = { command: input.command };
    if (input.working_dir !== undefined) extraFields.working_dir = input.working_dir;
    if (input.timeout_seconds !== undefined)
      extraFields.timeout_seconds = input.timeout_seconds;
    if (input.env && Object.keys(input.env).length > 0) extraFields.env = input.env;

    try {
      const payload = await this.dispatchRequest(
        "host_bash",
        {},
        conversationId,
        signal,
        extraFields,
        resolvedTargetClientId,
        proxyTimeoutMs,
      );
      return formatShellOutput(
        payload.stdout,
        payload.stderr,
        payload.exitCode,
        payload.timedOut,
        timeoutSec,
      );
    } catch (err) {
      if (err instanceof HostProxyRequestError) {
        if (err.reason === "timeout") {
          log.warn(
            { command: input.command },
            "Host bash proxy request timed out",
          );
          const msg = resolvedTargetClientId
            ? `Host bash proxy timed out waiting for response from client ${resolvedTargetClientId}`
            : "Host bash proxy timed out waiting for client response";
          return formatShellOutput("", msg, null, true, timeoutSec);
        }
        if (err.reason === "aborted") {
          return formatShellOutput("", "Aborted", null, false, 0);
        }
      }
      throw err;
    }
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
    pendingInteractions.resolve(requestId, "answered");
    this.resolve(requestId, response);
  }
}

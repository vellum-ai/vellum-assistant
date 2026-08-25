/**
 * Screen observation raised by the daemon outside any conversation or tool
 * call.
 *
 * `computer_use_observe` normally reaches the desktop client through
 * `HostCuProxy`, which only exists inside an agent turn. This helper drives the
 * `host_cu` wire protocol directly for callers that have no turn to hang the
 * request off: it mints a requestId, registers a pending interaction,
 * broadcasts a `host_cu_request` envelope to a single client, and awaits that
 * client's POST to `/v1/host-cu-result`.
 *
 * Every request is bound to the actor principal that initiated it, the same
 * binding `HostBashProxy.request()` applies. The target client is either
 * auto-resolved among that actor's own `host_cu` clients
 * ({@link pickSameUserAutoResolve}) or, when named explicitly, checked against
 * the actor before dispatch ({@link enforceSameActorOrErrorResult}), so a
 * caller can only capture the accessibility tree and screenshot of a machine
 * its own authenticated user is signed in on.
 *
 * Every failure path resolves to `{ ok: false, reason }` rather than throwing:
 * a caller observing in the background must degrade, never crash.
 */

import { randomUUID } from "node:crypto";

import { getLogger } from "../util/logger.js";
import { assistantEventHub, broadcastMessage } from "./assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "./auth/same-actor.js";
import * as pendingInteractions from "./pending-interactions.js";

const log = getLogger("host-observe");

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;
const MAX_OBSERVE_TIMEOUT_MS = 120_000;

const NO_CLIENT_REASON =
  "No connected client supports screen observation for this user. Make sure the desktop app is running and signed in.";

/**
 * Observation fields returned by the host CU executor. Mirrors the optional
 * fields of `CU_RESULT_SCHEMA` (see
 * `packages/electron-desktop/src/host-proxy/cu-executor.ts`) so the executor's
 * result deserializes as-is. `executionResult` and `secondaryWindows` are
 * omitted: an observe-only request executes no action, so they carry nothing
 * for the caller.
 */
export interface HostObservationFields {
  axTree?: string;
  axDiff?: string;
  screenshot?: string;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  screenWidthPt?: number;
  screenHeightPt?: number;
  executionError?: string;
}

/** A successful observation, or a structured failure. Never throws. */
export type HostObservation =
  | ({ ok: true } & HostObservationFields)
  | { ok: false; reason: string; timedOut?: boolean };

export interface ObserveHostScreenOptions {
  /**
   * Principal id of the actor on whose behalf the observation is taken.
   * Required, and the only identity the target client is matched against.
   * `undefined` (no authenticated actor) fails closed: it selects no client
   * and rejects any explicitly named one.
   */
  sourceActorPrincipalId: string | undefined;
  /** How long to wait for the client. Defaults to 30s, capped at 120s. */
  timeoutMs?: number;
  /** Keep the base64 screenshot in the result. Defaults to true. */
  includeScreenshot?: boolean;
  /**
   * Target a specific client. Must belong to `sourceActorPrincipalId`.
   * Defaults to the actor's own `host_cu` client when exactly one is
   * connected.
   */
  clientId?: string;
}

/**
 * Failure raised by this module's own lifecycle paths (timeout, send failure),
 * as opposed to an observation delivered by the client. Distinguished from
 * {@link HostObservationFields} by its `failureReason` key.
 */
interface LocalFailure {
  failureReason: string;
  timedOut: boolean;
}

/**
 * Resolve the `host_cu` client to observe, bound to the initiating actor.
 * Returns the client id, or the failure to hand back to the caller.
 */
function resolveObserveTarget(
  sourceActorPrincipalId: string | undefined,
  clientId: string | undefined,
): { clientId: string } | { reason: string } {
  let resolvedClientId: string;
  if (clientId) {
    const target = assistantEventHub.getClientById(clientId);
    if (!target?.capabilities.includes("host_cu")) {
      return {
        reason: `Client "${clientId}" is not connected or does not support host_cu.`,
      };
    }
    resolvedClientId = clientId;
  } else {
    // Auto-resolve to the unique same-user client. Refusing the ambiguous case
    // keeps one observation from fanning out across every machine the user has
    // connected.
    const resolved = pickSameUserAutoResolve({
      hub: assistantEventHub,
      capability: "host_cu",
      sourceActorPrincipalId,
    });
    if (resolved.kind === "ambiguous") {
      return { reason: ambiguousSameUserError("host_cu").content };
    }
    if (resolved.kind === "none") {
      return { reason: NO_CLIENT_REASON };
    }
    resolvedClientId = resolved.clientId;
  }

  // Fail closed before registration and before broadcast, so no caller reaches
  // a client whose authenticated user is not its own.
  const rejection = enforceSameActorOrErrorResult({
    hub: assistantEventHub,
    sourceActorPrincipalId,
    targetClientId: resolvedClientId,
    op: "host_cu",
  });
  if (rejection) {
    return { reason: rejection.content };
  }
  return { clientId: resolvedClientId };
}

/**
 * Ask the initiating actor's `host_cu`-capable client for the current screen
 * state.
 */
export async function observeHostScreen(
  options: ObserveHostScreenOptions,
): Promise<HostObservation> {
  const { sourceActorPrincipalId, includeScreenshot = true } = options;
  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS,
    MAX_OBSERVE_TIMEOUT_MS,
  );

  const target = resolveObserveTarget(sourceActorPrincipalId, options.clientId);
  if ("reason" in target) {
    return { ok: false, reason: target.reason };
  }
  const targetClientId = target.clientId;

  const requestId = randomUUID();

  // `/v1/host-cu-result` resolves this promise with the client's raw
  // observation fields; the lifecycle paths below resolve it with a failure.
  const payload = await new Promise<HostObservationFields | LocalFailure>(
    (resolvePromise) => {
      const timer = setTimeout(() => {
        // Resolve the tracker first so a late client POST is tolerated as a
        // no-op instead of double-resolving this promise.
        if (!pendingInteractions.resolve(requestId, "cancelled")) {
          return;
        }
        broadcastMessage(
          { type: "host_cu_cancel", requestId, conversationId: "" },
          undefined,
          { targetClientId },
        );
        resolvePromise({
          failureReason: `Timed out after ${timeoutMs}ms waiting for the desktop client. It may be busy, outdated, or disconnected.`,
          timedOut: true,
        });
      }, timeoutMs);

      // The target's actor principal is present by construction: the same-actor
      // check above rejects a client that registered without one.
      const targetActorPrincipalId =
        assistantEventHub.getActorPrincipalIdForClient(targetClientId);
      pendingInteractions.register(requestId, {
        kind: "host_cu",
        rpcResolve: resolvePromise as (value: unknown) => void,
        timer,
        targetClientId,
        ...(targetActorPrincipalId ? { targetActorPrincipalId } : {}),
      });

      try {
        broadcastMessage(
          {
            type: "host_cu_request",
            requestId,
            // Conversation-agnostic. The native helper keys its per-session
            // state off this id, and an empty string is already what the
            // desktop executor sends when no conversation is attached.
            conversationId: "",
            toolName: "computer_use_observe",
            input: {},
            stepNumber: 1,
          },
          undefined,
          { targetClientId },
        );
      } catch (err) {
        pendingInteractions.resolve(requestId, "cancelled");
        log.warn({ requestId, err }, "Screen observation broadcast failed");
        resolvePromise({
          failureReason: `Failed to reach the desktop client: ${String(err)}`,
          timedOut: false,
        });
      }
    },
  );

  if ("failureReason" in payload) {
    return {
      ok: false,
      reason: payload.failureReason,
      ...(payload.timedOut ? { timedOut: true } : {}),
    };
  }

  const { executionError, ...observation } = payload;
  if (executionError) {
    return { ok: false, reason: executionError };
  }

  if (!includeScreenshot) {
    delete observation.screenshot;
    delete observation.screenshotWidthPx;
    delete observation.screenshotHeightPx;
  }
  return { ok: true, ...observation };
}

/**
 * Daemon-initiated screen observation, outside any conversation or tool call.
 *
 * `computer_use_observe` normally reaches the desktop client through
 * `HostCuProxy`, which only exists inside an agent turn. A watch session needs
 * the same observation while no turn is running, so this helper drives the
 * `host_cu` wire protocol directly: mint a requestId, register a pending
 * interaction, broadcast a `host_cu_request` envelope, and await the client's
 * POST to `/v1/host-cu-result`. The flow mirrors the staged UI-snapshot request
 * in `routes/ui-snapshot-routes.ts`, the existing precedent for a
 * conversation-agnostic host request.
 *
 * No new host-proxy executor kind is involved: the client's existing `host_cu`
 * registration services the request unchanged, and the observation fields
 * mirror `CU_RESULT_SCHEMA` exactly so the executor's result deserializes as-is.
 *
 * Every failure path resolves to `{ ok: false, reason }` rather than throwing —
 * a watch session must degrade, never crash.
 */

import { randomUUID } from "node:crypto";

import { getLogger } from "../util/logger.js";
import { assistantEventHub, broadcastMessage } from "./assistant-event-hub.js";
import * as pendingInteractions from "./pending-interactions.js";

const log = getLogger("host-observe");

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000;
const MAX_OBSERVE_TIMEOUT_MS = 120_000;

/**
 * Observation fields returned by the host CU executor. Mirrors the optional
 * fields of `CU_RESULT_SCHEMA` (see
 * `packages/electron-desktop/src/host-proxy/cu-executor.ts`) so the existing
 * executor result deserializes unchanged. `executionResult` and
 * `secondaryWindows` are omitted: an observe-only request executes no action,
 * so they carry nothing for a watch session.
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
  /** How long to wait for the client. Defaults to 30s, capped at 120s. */
  timeoutMs?: number;
  /** Keep the base64 screenshot in the result. Defaults to true. */
  includeScreenshot?: boolean;
  /** Target a specific client; defaults to the most recently active one. */
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
 * Ask a connected `host_cu`-capable client for the current screen state.
 */
export async function observeHostScreen(
  options: ObserveHostScreenOptions = {},
): Promise<HostObservation> {
  const { includeScreenshot = true, clientId } = options;
  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS,
    MAX_OBSERVE_TIMEOUT_MS,
  );

  const client = clientId
    ? assistantEventHub.getClientById(clientId)
    : assistantEventHub.getMostRecentClientByCapability("host_cu");
  if (!client?.capabilities.includes("host_cu")) {
    return {
      ok: false,
      reason: clientId
        ? `Client "${clientId}" is not connected or does not support host_cu.`
        : "No connected client supports screen observation. Make sure the desktop app is running.",
    };
  }

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
          { targetClientId: client.clientId },
        );
        resolvePromise({
          failureReason: `Timed out after ${timeoutMs}ms waiting for the desktop client. It may be busy, outdated, or disconnected.`,
          timedOut: true,
        });
      }, timeoutMs);

      // Arm the same-actor result check only when the target client has a
      // verified actor principal; a legacy/service connection would otherwise
      // fail `missing_target` on its own legitimate result.
      const targetActorPrincipalId =
        assistantEventHub.getActorPrincipalIdForClient(client.clientId);
      pendingInteractions.register(requestId, {
        kind: "host_cu",
        rpcResolve: resolvePromise as (value: unknown) => void,
        timer,
        ...(targetActorPrincipalId
          ? { targetClientId: client.clientId, targetActorPrincipalId }
          : {}),
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
          { targetClientId: client.clientId },
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

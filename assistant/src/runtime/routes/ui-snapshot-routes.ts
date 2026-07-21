/**
 * Routes for the staged UI-snapshot flow (`assistant ui snapshot`).
 *
 * `ui_snapshot` (IPC-eligible, CLI-facing) asks the most recent connected
 * desktop client to render a staged view of the app with the current
 * validated workspace-theme tokens and return a PNG capture. The request is
 * conversation-agnostic: it registers a pending interaction that resolves
 * via `rpcResolve` when the client POSTs to `host_ui_snapshot_result`
 * (HTTP-only, like the other host result routes).
 *
 * The staged views contain only fixed generic content — never user data —
 * so no permission gate applies; an unavailable or outdated client degrades
 * to a clean error the CLI can explain.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  HostUiSnapshotResultPayload,
  HostUiSnapshotView,
} from "../../daemon/message-types/host-ui-snapshot.js";
import { readWorkspaceTheme } from "../../theme/workspace-theme.js";
import { assistantEventHub, broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  enforceSameActorOrThrow,
  SAME_ACTOR_FORBIDDEN_DESCRIPTION,
} from "../auth/same-actor.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, ForbiddenError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_TIMEOUT_MS = 120_000;

const SnapshotRequestParams = z.object({
  view: z.enum(["sampler", "chat"]).default("sampler"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_SNAPSHOT_TIMEOUT_MS)
    .optional(),
});

export interface UiSnapshotResult {
  ok: boolean;
  pngBase64?: string;
  widthPx?: number;
  heightPx?: number;
  /** Where the embedded theme came from: the validated file, an invalid file, or no file. */
  themeSource: "workspace" | "invalid" | "none";
  /** Validation issues when the theme file exists but was rejected. */
  themeIssues: string[];
  timedOut?: boolean;
  error?: string;
}

async function handleUiSnapshot({
  body = {},
}: RouteHandlerArgs): Promise<UiSnapshotResult> {
  const { view, timeoutMs } = SnapshotRequestParams.parse(body);

  const theme = readWorkspaceTheme();
  const themeContext = {
    themeSource: theme.source,
    themeIssues: theme.issues,
  } as const;

  const client =
    assistantEventHub.getMostRecentClientByCapability("host_ui_snapshot");
  if (!client) {
    return {
      ok: false,
      ...themeContext,
      error:
        "No connected desktop client supports UI snapshots. Make sure the desktop app is running and up to date.",
    };
  }

  const requestId = randomUUID();
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

  const payload = await new Promise<HostUiSnapshotResultPayload>(
    (resolvePromise) => {
      const timer = setTimeout(() => {
        // Resolve the tracker first so a late client POST is tolerated as a
        // no-op instead of double-resolving this promise.
        const entry = pendingInteractions.resolve(requestId, "cancelled");
        if (!entry) {
          return;
        }
        broadcastMessage(
          { type: "host_ui_snapshot_cancel", requestId },
          undefined,
          { targetClientId: client.clientId },
        );
        resolvePromise({
          requestId,
          isError: true,
          errorMessage: `Timed out after ${effectiveTimeoutMs}ms waiting for the desktop client. It may be busy, outdated, or disconnected.`,
        });
      }, effectiveTimeoutMs);

      // Arm the same-actor result check only when the target client has a
      // verified actor principal; a legacy/service connection would otherwise
      // fail `missing_target` on its own legitimate result.
      const targetActorPrincipalId =
        assistantEventHub.getActorPrincipalIdForClient(client.clientId);
      pendingInteractions.register(requestId, {
        kind: "host_ui_snapshot",
        rpcResolve: resolvePromise as (value: unknown) => void,
        timer,
        ...(targetActorPrincipalId
          ? { targetClientId: client.clientId, targetActorPrincipalId }
          : {}),
        metadata: { view },
      });

      broadcastMessage(
        {
          type: "host_ui_snapshot_request",
          requestId,
          view: view as HostUiSnapshotView,
          ...(theme.theme?.tokens ? { tokens: theme.theme.tokens } : {}),
        },
        undefined,
        { targetClientId: client.clientId },
      );
    },
  );

  if (payload.isError || !payload.pngBase64) {
    return {
      ok: false,
      ...themeContext,
      timedOut: payload.errorMessage?.startsWith("Timed out") || undefined,
      error: payload.errorMessage ?? "The desktop client returned no capture.",
    };
  }

  return {
    ok: true,
    pngBase64: payload.pngBase64,
    widthPx: payload.widthPx,
    heightPx: payload.heightPx,
    ...themeContext,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/host-ui-snapshot-result
// ---------------------------------------------------------------------------

async function handleHostUiSnapshotResult({ body, headers }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }

  const { requestId, pngBase64, widthPx, heightPx, isError, errorMessage } =
    body as {
      requestId?: string;
      pngBase64?: string;
      widthPx?: number;
      heightPx?: number;
      isError?: boolean;
      errorMessage?: string;
    };

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("requestId is required");
  }

  // Late-delivery tolerance: if the pending interaction is already gone (the
  // request timed out), accept the post and move on — mirrors the other host
  // result routes.
  const peeked = pendingInteractions.get(requestId);
  if (!peeked || peeked.kind !== "host_ui_snapshot") {
    return { accepted: true };
  }

  // Same-actor binding: the targeted client must be the one submitting.
  if (peeked.targetClientId != null) {
    const headerMap = headers ?? {};
    const submittingClientId =
      headerMap["x-vellum-client-id"]?.trim() || undefined;
    if (!submittingClientId) {
      throw new BadRequestError(
        "x-vellum-client-id header is missing for a targeted UI-snapshot request.",
      );
    }
    if (submittingClientId !== peeked.targetClientId) {
      throw new ForbiddenError(
        `Client "${submittingClientId}" is not the target for this request (expected "${peeked.targetClientId}"). The targeted client must submit the result.`,
      );
    }
    const submittingActorPrincipalId =
      await resolveActorPrincipalIdForLocalGuardian(
        headerMap["x-vellum-actor-principal-id"]?.trim() || undefined,
      );
    enforceSameActorOrThrow({
      sourceActorPrincipalId: submittingActorPrincipalId,
      targetActorPrincipalId: peeked.targetActorPrincipalId,
      targetClientId: peeked.targetClientId,
      op: "host_ui_snapshot",
    });
  }

  const interaction = pendingInteractions.resolve(requestId, "answered");
  const payload: HostUiSnapshotResultPayload = {
    requestId,
    ...(pngBase64 !== undefined ? { pngBase64 } : {}),
    ...(widthPx !== undefined ? { widthPx } : {}),
    ...(heightPx !== undefined ? { heightPx } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
  interaction?.rpcResolve?.(payload);

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "ui_snapshot",
    endpoint: "ui/snapshot",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Capture a staged UI snapshot",
    description:
      "Ask the connected desktop client to render a staged view of the app " +
      "(sampler or chat) with the current workspace-theme tokens applied and " +
      "return a PNG capture. The staged views contain only fixed generic " +
      "content. Blocks until the client responds or the timeout elapses.",
    tags: ["host"],
    requestBody: z.object({
      view: z
        .enum(["sampler", "chat"])
        .default("sampler")
        .describe("Which staged composition to capture"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_SNAPSHOT_TIMEOUT_MS)
        .optional()
        .describe("How long to wait for the client capture"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      pngBase64: z
        .string()
        .describe("Base64 PNG capture of the staged view")
        .optional(),
      widthPx: z.number().optional(),
      heightPx: z.number().optional(),
      themeSource: z.enum(["workspace", "invalid", "none"]),
      themeIssues: z.array(z.string()),
      timedOut: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: handleUiSnapshot,
  },
  {
    operationId: "host_ui_snapshot_result",
    endpoint: "host-ui-snapshot-result",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    requireGuardian: true,
    summary: "Submit host UI-snapshot result",
    description:
      "Resolve a pending UI-snapshot request by requestId. Returns 200 even " +
      "when no pending interaction matches (late delivery is tolerated).",
    tags: ["host"],
    requestBody: z.object({
      requestId: z.string().describe("Pending UI-snapshot request ID"),
      pngBase64: z
        .string()
        .describe("Base64 PNG capture of the staged view")
        .optional(),
      widthPx: z.number().optional(),
      heightPx: z.number().optional(),
      isError: z.boolean().optional(),
      errorMessage: z.string().optional(),
    }),
    responseBody: z.object({
      accepted: z.boolean(),
    }),
    additionalResponses: {
      "400": {
        description:
          "x-vellum-client-id header is missing for a targeted UI-snapshot request.",
      },
      "403": {
        description: SAME_ACTOR_FORBIDDEN_DESCRIPTION,
      },
    },
    handler: handleHostUiSnapshotResult,
  },
];

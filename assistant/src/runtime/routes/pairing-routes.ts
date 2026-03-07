/**
 * Pairing HTTP route handlers for device pairing flow.
 */

import {
  hashDeviceId,
  isDeviceApproved,
  refreshDevice,
} from "../../daemon/approved-devices-store.js";
import type { ServerMessage } from "../../daemon/ipc-protocol.js";
import { PairingStore } from "../../daemon/pairing-store.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { mintCredentialPair } from "../auth/credential-service.js";
import { ensureVellumGuardianBinding } from "../guardian-vellum-migration.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("runtime-http");

interface PairingCredentials {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

/**
 * Mint credentials (access token + refresh token) for a paired device.
 * Returns the full credential set, or null if minting fails.
 *
 * NOTE: This function MUST remain synchronous — the mintingInFlight guard depends on it.
 */
function mintPairingCredentials(
  deviceId: string,
  platform: string,
): PairingCredentials | null {
  try {
    // Pairing can run before a local client has touched the actor-token
    // bootstrap path. Ensure the vellum guardian principal exists so iOS
    // pairings always have a mint target.
    const guardianPrincipalId = ensureVellumGuardianBinding(
      DAEMON_INTERNAL_ASSISTANT_ID,
    );
    const hashedDeviceId = hashDeviceId(deviceId);

    const credentials = mintCredentialPair({
      platform,
      deviceId,
      guardianPrincipalId,
      hashedDeviceId,
    });

    log.info({ platform }, "Minted credentials during pairing");
    return {
      accessToken: credentials.accessToken,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      refreshToken: credentials.refreshToken,
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
      refreshAfter: credentials.refreshAfter,
    };
  } catch (err) {
    log.warn(
      { err },
      "Failed to mint credentials during pairing — continuing without them",
    );
    return null;
  }
}

/**
 * Transient in-memory map of pairingRequestId -> { deviceId, createdAt }.
 * Stored when a pairing request is initiated (we have the raw deviceId)
 * so the token can be minted later when the pairing is actually approved.
 * Entries include a timestamp so stale entries can be swept if the
 * corresponding pairing expires without an explicit deny.
 */
const PENDING_DEVICE_ID_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingDeviceIds = new Map<
  string,
  { deviceId: string; createdAt: number }
>();

/**
 * Transient in-memory map of pairingRequestId -> { credentials, approvedAt }.
 * Populated when a pairing is approved and credentials are minted.
 * Entries are kept for CREDENTIAL_RETRIEVAL_TTL_MS after approval so that
 * subsequent polls can still retrieve them if the first response
 * was dropped or timed out.
 */
const CREDENTIAL_RETRIEVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const approvedCredentials = new Map<
  string,
  { credentials: PairingCredentials; approvedAt: number }
>();

/**
 * Sweep stale entries from the approved credentials map.
 * Called lazily on each status poll.
 */
function sweepApprovedCredentials(): void {
  const now = Date.now();
  for (const [id, entry] of approvedCredentials) {
    if (now - entry.approvedAt > CREDENTIAL_RETRIEVAL_TTL_MS) {
      approvedCredentials.delete(id);
    }
  }
}

/**
 * Sweep stale entries from the pending device IDs map.
 * Entries older than PENDING_DEVICE_ID_TTL_MS are removed to prevent
 * unbounded accumulation of raw device identifiers when pairings expire
 * without an explicit deny.
 */
function sweepPendingDeviceIds(): void {
  const now = Date.now();
  for (const [id, entry] of pendingDeviceIds) {
    if (now - entry.createdAt > PENDING_DEVICE_ID_TTL_MS) {
      pendingDeviceIds.delete(id);
    }
  }
}

/**
 * In-flight mint guard — prevents overlapping status polls from triggering
 * concurrent token mints for the same pairing request. The second mint
 * would revoke the first token, leaving the client with an invalid token.
 *
 * MUST remain synchronous — async would break this concurrency guard.
 */
const mintingInFlight = new Set<string>();

/**
 * Clean up all transient pairing state for a given request.
 * Called when pairing is denied or otherwise finalized.
 */
export function cleanupPairingState(pairingRequestId: string): void {
  pendingDeviceIds.delete(pairingRequestId);
  approvedCredentials.delete(pairingRequestId);
  mintingInFlight.delete(pairingRequestId);
}

export interface PairingHandlerContext {
  pairingStore: PairingStore;
  bearerToken: string | undefined;
  /** Feature-flag client token to include in pairing approval responses so iOS can PATCH flags. */
  featureFlagToken: string | undefined;
  pairingBroadcast?: (msg: ServerMessage) => void;
}

/**
 * POST /v1/pairing/register -- Bearer-authenticated.
 * macOS pre-registers a pairing request when the QR is displayed.
 */
export async function handlePairingRegister(
  req: Request,
  ctx: PairingHandlerContext,
): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const pairingRequestId =
      typeof body.pairingRequestId === "string" ? body.pairingRequestId : "";
    const pairingSecret =
      typeof body.pairingSecret === "string" ? body.pairingSecret : "";
    const gatewayUrl =
      typeof body.gatewayUrl === "string" ? body.gatewayUrl : "";
    const localLanUrl =
      typeof body.localLanUrl === "string" ? body.localLanUrl : null;

    if (!pairingRequestId || !pairingSecret || !gatewayUrl) {
      return httpError(
        "BAD_REQUEST",
        "Missing required fields: pairingRequestId, pairingSecret, gatewayUrl",
        400,
      );
    }

    const result = ctx.pairingStore.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl,
      localLanUrl,
    });
    if (!result.ok) {
      const message =
        result.reason === "active_pairing"
          ? "A pairing request is already in progress"
          : "Conflict: pairingRequestId exists with different secret";
      return httpError("CONFLICT", message, 409);
    }

    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err }, "Failed to register pairing request");
    return httpError("INTERNAL_ERROR", "Internal server error", 500);
  }
}

/**
 * POST /v1/pairing/request -- Unauthenticated (secret-gated).
 * iOS initiates a pairing handshake.
 */
export async function handlePairingRequest(
  req: Request,
  ctx: PairingHandlerContext,
): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const pairingRequestId =
      typeof body.pairingRequestId === "string" ? body.pairingRequestId : "";
    const pairingSecret =
      typeof body.pairingSecret === "string" ? body.pairingSecret : "";
    const deviceId =
      typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const deviceName =
      typeof body.deviceName === "string" ? body.deviceName.trim() : "";

    // Redact secret from any potential logging of body
    log.info(
      { pairingRequestId, deviceName, hasDeviceId: !!deviceId },
      "Pairing request received",
    );

    if (!deviceId || !deviceName) {
      return httpError(
        "BAD_REQUEST",
        "Missing required fields: deviceId, deviceName",
        400,
      );
    }

    if (!pairingRequestId || !pairingSecret) {
      return httpError(
        "BAD_REQUEST",
        "Missing required fields: pairingRequestId, pairingSecret",
        400,
      );
    }

    const result = ctx.pairingStore.beginRequest({
      pairingRequestId,
      pairingSecret,
      deviceId,
      deviceName,
    });
    if (!result.ok) {
      if (result.reason === "already_paired") {
        return httpError(
          "CONFLICT",
          "This pairing request is already bound to another device",
          409,
        );
      }
      const statusCode =
        result.reason === "invalid_secret"
          ? 403
          : result.reason === "not_found"
            ? 403
            : 410;
      return httpError("FORBIDDEN", "Forbidden", statusCode);
    }

    const entry = result.entry;
    const hashedDeviceId = hashDeviceId(deviceId);

    // Auto-approve if device is in the allowlist
    if (isDeviceApproved(hashedDeviceId) && ctx.bearerToken) {
      refreshDevice(hashedDeviceId, deviceName);
      ctx.pairingStore.approve(pairingRequestId, ctx.bearerToken);
      log.info(
        { pairingRequestId, hashedDeviceId },
        "Auto-approved allowlisted device",
      );
      const credentials = mintPairingCredentials(deviceId, "ios");
      return Response.json({
        status: "approved",
        bearerToken: ctx.bearerToken,
        gatewayUrl: entry.gatewayUrl,
        localLanUrl: entry.localLanUrl,
        ...(ctx.featureFlagToken
          ? { featureFlagToken: ctx.featureFlagToken }
          : {}),
        ...(credentials
          ? {
              accessToken: credentials.accessToken,
              accessTokenExpiresAt: credentials.accessTokenExpiresAt,
              refreshToken: credentials.refreshToken,
              refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
              refreshAfter: credentials.refreshAfter,
            }
          : {}),
      });
    }

    // Store the raw deviceId transiently so we can mint the actor token
    // later when the pairing is actually approved (avoids revoking existing
    // tokens and creating DB records for unapproved devices).
    pendingDeviceIds.set(pairingRequestId, { deviceId, createdAt: Date.now() });

    // Send IPC to macOS to show approval prompt
    if (ctx.pairingBroadcast) {
      ctx.pairingBroadcast({
        type: "pairing_approval_request",
        pairingRequestId,
        deviceId: hashedDeviceId,
        deviceName,
      });
    }

    return Response.json({ status: "pending" });
  } catch (err) {
    log.error({ err }, "Failed to process pairing request");
    return httpError("INTERNAL_ERROR", "Internal server error", 500);
  }
}

/**
 * GET /v1/pairing/status?id=<id>&secret=<secret> -- Unauthenticated (secret-gated).
 * iOS polls for approval status.
 */
export function handlePairingStatus(
  url: URL,
  ctx: PairingHandlerContext,
): Response {
  const id = url.searchParams.get("id") ?? "";
  // Note: secret is redacted from logs
  const secret = url.searchParams.get("secret") ?? "";
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();

  if (!id || !secret) {
    return httpError("BAD_REQUEST", "Missing required params: id, secret", 400);
  }

  if (!ctx.pairingStore.validateSecret(id, secret)) {
    return httpError("FORBIDDEN", "Forbidden", 403);
  }

  // Sweep stale transient entries on every poll — not just approved ones —
  // so abandoned pairing attempts don't accumulate indefinitely.
  sweepApprovedCredentials();
  sweepPendingDeviceIds();

  const entry = ctx.pairingStore.get(id);
  if (!entry) {
    // Pairing expired or was swept — clean up any lingering pending device ID
    pendingDeviceIds.delete(id);
    return httpError("NOT_FOUND", "Not found", 404);
  }

  if (entry.status === "approved") {
    // Mint credentials on first approved poll if we still have the
    // raw deviceId from the pairing request. Once minted, credentials are
    // cached in approvedCredentials with a TTL so subsequent polls can
    // still retrieve them if the first response was dropped.
    // The pending deviceId is only removed after a successful mint so
    // transient failures allow retries on subsequent polls.
    let credentialEntry = approvedCredentials.get(id);
    if (!credentialEntry && !mintingInFlight.has(id)) {
      const pending = pendingDeviceIds.get(id);
      const deviceIdMatchesEntry = Boolean(
        deviceId &&
        entry.hashedDeviceId &&
        hashDeviceId(deviceId) === entry.hashedDeviceId,
      );
      const mintDeviceId =
        pending?.deviceId ?? (deviceIdMatchesEntry ? deviceId : undefined);
      if (mintDeviceId) {
        mintingInFlight.add(id);
        try {
          const credentials = mintPairingCredentials(mintDeviceId, "ios");
          if (credentials) {
            pendingDeviceIds.delete(id);
            credentialEntry = { credentials, approvedAt: Date.now() };
            approvedCredentials.set(id, credentialEntry);
          }
        } finally {
          mintingInFlight.delete(id);
        }
      }
    }

    return Response.json({
      status: "approved",
      bearerToken: entry.bearerToken,
      gatewayUrl: entry.gatewayUrl,
      localLanUrl: entry.localLanUrl,
      ...(ctx.featureFlagToken
        ? { featureFlagToken: ctx.featureFlagToken }
        : {}),
      ...(credentialEntry
        ? {
            accessToken: credentialEntry.credentials.accessToken,
            accessTokenExpiresAt:
              credentialEntry.credentials.accessTokenExpiresAt,
            refreshToken: credentialEntry.credentials.refreshToken,
            refreshTokenExpiresAt:
              credentialEntry.credentials.refreshTokenExpiresAt,
            refreshAfter: credentialEntry.credentials.refreshAfter,
          }
        : {}),
    });
  }

  return Response.json({ status: entry.status });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function pairingRouteDefinitions(deps: {
  getPairingContext: () => PairingHandlerContext;
}): RouteDefinition[] {
  return [
    {
      endpoint: "pairing/register",
      method: "POST",
      handler: async ({ req }) =>
        handlePairingRegister(req, deps.getPairingContext()),
    },
  ];
}

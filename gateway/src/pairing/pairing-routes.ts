/**
 * Gateway-native pairing route handlers.
 *
 * Handles the full iOS pairing flow directly in the gateway:
 *   - POST /pairing/register  — macOS pre-registers a pairing request (QR displayed)
 *   - POST /pairing/request   — iOS initiates a pairing handshake
 *   - GET  /pairing/status    — iOS polls for approval status
 *
 * Credentials (JWT access token + opaque refresh token) are minted via
 * guardian-bootstrap, which writes directly to the assistant's SQLite
 * database with dual-writes to the gateway DB.
 */

import { bootstrapGuardian } from "../auth/guardian-bootstrap.js";
import { mintServiceToken } from "../auth/token-exchange.js";
import { getLogger } from "../logger.js";

import {
  hashDeviceId,
  isDeviceApproved,
  refreshDevice,
} from "./approved-devices-store.js";
import { PairingStore } from "./pairing-store.js";

const log = getLogger("pairing-routes");

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

interface PairingCredentials {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

// ---------------------------------------------------------------------------
// Credential minting (delegates to gateway's guardian-bootstrap)
// ---------------------------------------------------------------------------

function mintPairingCredentials(
  deviceId: string,
  platform: string,
): PairingCredentials | null {
  try {
    const result = bootstrapGuardian({ platform, deviceId });
    log.info({ platform }, "Minted credentials during pairing");
    return {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      refreshAfter: result.refreshAfter,
    };
  } catch (err) {
    log.warn(
      { err },
      "Failed to mint credentials during pairing — continuing without them",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transient in-memory state
// ---------------------------------------------------------------------------

const PAIRING_PENDING_DEVICE_ID_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingDeviceIds = new Map<
  string,
  { deviceId: string; createdAt: number }
>();

const PAIRING_CREDENTIAL_RETRIEVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const approvedCredentials = new Map<
  string,
  { credentials: PairingCredentials; approvedAt: number }
>();

function sweepApprovedCredentials(): void {
  const now = Date.now();
  for (const [id, entry] of approvedCredentials) {
    if (now - entry.approvedAt > PAIRING_CREDENTIAL_RETRIEVAL_TTL_MS) {
      approvedCredentials.delete(id);
    }
  }
}

function sweepPendingDeviceIds(): void {
  const now = Date.now();
  for (const [id, entry] of pendingDeviceIds) {
    if (now - entry.createdAt > PAIRING_PENDING_DEVICE_ID_TTL_MS) {
      pendingDeviceIds.delete(id);
    }
  }
}

const mintingInFlight = new Set<string>();

function cleanupPairingState(pairingRequestId: string): void {
  pendingDeviceIds.delete(pairingRequestId);
  approvedCredentials.delete(pairingRequestId);
  mintingInFlight.delete(pairingRequestId);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MAX_PAIRING_BODY_BYTES = 4096;

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// Route handler factory
// ---------------------------------------------------------------------------

export function createPairingHandler(deps: {
  pairingStore: PairingStore;
  getBearerToken?: () => string | undefined;
}) {
  const { pairingStore } = deps;

  function getOrMintBearerToken(): string | undefined {
    if (deps.getBearerToken) {
      const token = deps.getBearerToken();
      if (token) return token;
    }
    try {
      return mintServiceToken();
    } catch {
      return undefined;
    }
  }

  return {
    /**
     * POST /pairing/register — Bearer-authenticated.
     * macOS pre-registers a pairing request when the QR is displayed.
     */
    async handlePairingRegister(req: Request): Promise<Response> {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const pairingRequestId =
          typeof body.pairingRequestId === "string"
            ? body.pairingRequestId
            : "";
        const pairingSecret =
          typeof body.pairingSecret === "string" ? body.pairingSecret : "";
        const gatewayUrl =
          typeof body.gatewayUrl === "string" ? body.gatewayUrl : "";
        const localLanUrl =
          typeof body.localLanUrl === "string" ? body.localLanUrl : null;

        if (!pairingRequestId || !pairingSecret || !gatewayUrl) {
          return jsonError(
            "BAD_REQUEST",
            "Missing required fields: pairingRequestId, pairingSecret, gatewayUrl",
            400,
          );
        }

        const result = pairingStore.register({
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
          return jsonError("CONFLICT", message, 409);
        }

        return Response.json({ ok: true });
      } catch (err) {
        log.error({ err }, "Failed to register pairing request");
        return jsonError("INTERNAL_ERROR", "Internal server error", 500);
      }
    },

    /**
     * POST /pairing/request — Unauthenticated (secret-gated).
     * iOS initiates a pairing handshake.
     */
    async handlePairingRequest(req: Request): Promise<Response> {
      try {
        const contentLength = req.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_PAIRING_BODY_BYTES) {
          return jsonError("BAD_REQUEST", "Payload too large", 413);
        }
        const body = (await req.json()) as Record<string, unknown>;
        const pairingRequestId =
          typeof body.pairingRequestId === "string"
            ? body.pairingRequestId
            : "";
        const pairingSecret =
          typeof body.pairingSecret === "string" ? body.pairingSecret : "";
        const deviceId =
          typeof body.deviceId === "string" ? body.deviceId.trim() : "";
        const deviceName =
          typeof body.deviceName === "string" ? body.deviceName.trim() : "";

        log.info(
          { pairingRequestId, deviceName, hasDeviceId: !!deviceId },
          "Pairing request received",
        );

        if (!deviceId || !deviceName) {
          return jsonError(
            "BAD_REQUEST",
            "Missing required fields: deviceId, deviceName",
            400,
          );
        }

        if (!pairingRequestId || !pairingSecret) {
          return jsonError(
            "BAD_REQUEST",
            "Missing required fields: pairingRequestId, pairingSecret",
            400,
          );
        }

        const result = pairingStore.beginRequest({
          pairingRequestId,
          pairingSecret,
          deviceId,
          deviceName,
        });
        if (!result.ok) {
          if (result.reason === "already_paired") {
            return jsonError(
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
          return jsonError("FORBIDDEN", "Forbidden", statusCode);
        }

        const entry = result.entry;
        const hashedDeviceId = hashDeviceId(deviceId);
        const bearerToken = getOrMintBearerToken();

        // Auto-approve if device is in the allowlist
        if (isDeviceApproved(hashedDeviceId) && bearerToken) {
          refreshDevice(hashedDeviceId, deviceName);
          pairingStore.approve(pairingRequestId, bearerToken);
          log.info(
            { pairingRequestId, hashedDeviceId },
            "Auto-approved allowlisted device",
          );
          const credentials = mintPairingCredentials(deviceId, "ios");
          return Response.json({
            status: "approved",
            bearerToken,
            gatewayUrl: entry.gatewayUrl,
            localLanUrl: entry.localLanUrl,
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
        // later when the pairing is actually approved.
        pendingDeviceIds.set(pairingRequestId, {
          deviceId,
          createdAt: Date.now(),
        });

        return Response.json({ status: "pending" });
      } catch (err) {
        log.error({ err }, "Failed to process pairing request");
        return jsonError("INTERNAL_ERROR", "Internal server error", 500);
      }
    },

    /**
     * GET /pairing/status — Unauthenticated (secret-gated).
     * iOS polls for approval status.
     */
    handlePairingStatus(req: Request): Response {
      const url = new URL(req.url);
      const id = url.searchParams.get("id") ?? "";
      const secret = url.searchParams.get("secret") ?? "";
      const deviceId = (url.searchParams.get("deviceId") ?? "").trim();

      if (!id || !secret) {
        return jsonError(
          "BAD_REQUEST",
          "Missing required params: id, secret",
          400,
        );
      }

      if (!pairingStore.validateSecret(id, secret)) {
        return jsonError("FORBIDDEN", "Forbidden", 403);
      }

      sweepApprovedCredentials();
      sweepPendingDeviceIds();

      const entry = pairingStore.get(id);
      if (!entry) {
        pendingDeviceIds.delete(id);
        return jsonError("NOT_FOUND", "Not found", 404);
      }

      if (entry.status === "approved") {
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
    },

    cleanupPairingState,
  };
}

/**
 * Pairing HTTP route handlers for device pairing flow.
 */

import {
  hashDeviceId,
  isDeviceApproved,
  refreshDevice,
} from '../../daemon/approved-devices-store.js';
import type { ServerMessage } from '../../daemon/ipc-contract.js';
import { PairingStore } from '../../daemon/pairing-store.js';
import { getActiveBinding } from '../../memory/guardian-bindings.js';
import { getLogger } from '../../util/logger.js';
import { normalizeAssistantId } from '../../util/platform.js';
import { mintActorToken } from '../actor-token-service.js';
import {
  createActorTokenRecord,
  revokeByDeviceBinding,
} from '../actor-token-store.js';
import { httpError } from '../http-errors.js';

const log = getLogger('runtime-http');

/**
 * Mint an actor token for a paired device if a vellum guardian principal exists.
 * Returns the raw actor token string, or null if no vellum binding exists.
 */
function mintPairingActorToken(deviceId: string, platform: string): string | null {
  try {
    const assistantId = normalizeAssistantId('self');
    const binding = getActiveBinding(assistantId, 'vellum');
    if (!binding) return null;

    const guardianPrincipalId = binding.guardianExternalUserId;
    const hashedDeviceId = hashDeviceId(deviceId);

    // Revoke previous tokens for this device
    revokeByDeviceBinding(assistantId, guardianPrincipalId, hashedDeviceId);

    const { token, tokenHash, claims } = mintActorToken({
      assistantId,
      platform,
      deviceId,
      guardianPrincipalId,
    });

    createActorTokenRecord({
      tokenHash,
      assistantId,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });

    log.info({ assistantId, platform }, 'Minted actor token during pairing');
    return token;
  } catch (err) {
    log.warn({ err }, 'Failed to mint actor token during pairing — continuing without it');
    return null;
  }
}

/**
 * Transient in-memory map of pairingRequestId -> actorToken.
 * Actor tokens are minted when the pairing request is created (we have the
 * raw deviceId), and retrieved when the status is polled as approved.
 * Never persisted to disk — cleared when entries expire.
 */
const pendingActorTokens = new Map<string, string>();

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
export async function handlePairingRegister(req: Request, ctx: PairingHandlerContext): Promise<Response> {
  try {
    const body = await req.json() as Record<string, unknown>;
    const pairingRequestId = typeof body.pairingRequestId === 'string' ? body.pairingRequestId : '';
    const pairingSecret = typeof body.pairingSecret === 'string' ? body.pairingSecret : '';
    const gatewayUrl = typeof body.gatewayUrl === 'string' ? body.gatewayUrl : '';
    const localLanUrl = typeof body.localLanUrl === 'string' ? body.localLanUrl : null;

    if (!pairingRequestId || !pairingSecret || !gatewayUrl) {
      return httpError('BAD_REQUEST', 'Missing required fields: pairingRequestId, pairingSecret, gatewayUrl', 400);
    }

    const result = ctx.pairingStore.register({ pairingRequestId, pairingSecret, gatewayUrl, localLanUrl });
    if (!result.ok) {
      return httpError('CONFLICT', 'Conflict: pairingRequestId exists with different secret', 409);
    }

    return Response.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Failed to register pairing request');
    return httpError('INTERNAL_ERROR', 'Internal server error', 500);
  }
}

/**
 * POST /v1/pairing/request -- Unauthenticated (secret-gated).
 * iOS initiates a pairing handshake.
 */
export async function handlePairingRequest(req: Request, ctx: PairingHandlerContext): Promise<Response> {
  try {
    const body = await req.json() as Record<string, unknown>;
    const pairingRequestId = typeof body.pairingRequestId === 'string' ? body.pairingRequestId : '';
    const pairingSecret = typeof body.pairingSecret === 'string' ? body.pairingSecret : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : '';

    // Redact secret from any potential logging of body
    log.info({ pairingRequestId, deviceName, hasDeviceId: !!deviceId }, 'Pairing request received');

    if (!deviceId || !deviceName) {
      return httpError('BAD_REQUEST', 'Missing required fields: deviceId, deviceName', 400);
    }

    if (!pairingRequestId || !pairingSecret) {
      return httpError('BAD_REQUEST', 'Missing required fields: pairingRequestId, pairingSecret', 400);
    }

    const result = ctx.pairingStore.beginRequest({ pairingRequestId, pairingSecret, deviceId, deviceName });
    if (!result.ok) {
      if (result.reason === 'already_paired') {
        return httpError('CONFLICT', 'This pairing request is already bound to another device', 409);
      }
      const statusCode = result.reason === 'invalid_secret' ? 403 : result.reason === 'not_found' ? 403 : 410;
      return httpError('FORBIDDEN', 'Forbidden', statusCode);
    }

    const entry = result.entry;
    const hashedDeviceId = hashDeviceId(deviceId);

    // Auto-approve if device is in the allowlist
    if (isDeviceApproved(hashedDeviceId) && ctx.bearerToken) {
      refreshDevice(hashedDeviceId, deviceName);
      ctx.pairingStore.approve(pairingRequestId, ctx.bearerToken);
      log.info({ pairingRequestId, hashedDeviceId }, 'Auto-approved allowlisted device');
      const actorToken = mintPairingActorToken(deviceId, 'ios');
      return Response.json({
        status: 'approved',
        bearerToken: ctx.bearerToken,
        gatewayUrl: entry.gatewayUrl,
        localLanUrl: entry.localLanUrl,
        ...(ctx.featureFlagToken ? { featureFlagToken: ctx.featureFlagToken } : {}),
        ...(actorToken ? { actorToken } : {}),
      });
    }

    // Pre-mint actor token while we still have the raw deviceId.
    // Store in transient memory only — never on disk.
    const pendingActorToken = mintPairingActorToken(deviceId, 'ios');
    if (pendingActorToken) {
      pendingActorTokens.set(pairingRequestId, pendingActorToken);
    }

    // Send IPC to macOS to show approval prompt
    if (ctx.pairingBroadcast) {
      ctx.pairingBroadcast({
        type: 'pairing_approval_request',
        pairingRequestId,
        deviceId: hashedDeviceId,
        deviceName,
      });
    }

    return Response.json({ status: 'pending' });
  } catch (err) {
    log.error({ err }, 'Failed to process pairing request');
    return httpError('INTERNAL_ERROR', 'Internal server error', 500);
  }
}

/**
 * GET /v1/pairing/status?id=<id>&secret=<secret> -- Unauthenticated (secret-gated).
 * iOS polls for approval status.
 */
export function handlePairingStatus(url: URL, ctx: PairingHandlerContext): Response {
  const id = url.searchParams.get('id') ?? '';
  // Note: secret is redacted from logs
  const secret = url.searchParams.get('secret') ?? '';

  if (!id || !secret) {
    return httpError('BAD_REQUEST', 'Missing required params: id, secret', 400);
  }

  if (!ctx.pairingStore.validateSecret(id, secret)) {
    return httpError('FORBIDDEN', 'Forbidden', 403);
  }

  const entry = ctx.pairingStore.get(id);
  if (!entry) {
    return httpError('NOT_FOUND', 'Not found', 404);
  }

  if (entry.status === 'approved') {
    // Retrieve the pre-minted actor token from transient memory.
    // Cleared after retrieval to avoid leaking the token on repeated polls.
    const actorToken = pendingActorTokens.get(id);
    if (actorToken) {
      pendingActorTokens.delete(id);
    }
    return Response.json({
      status: 'approved',
      bearerToken: entry.bearerToken,
      gatewayUrl: entry.gatewayUrl,
      localLanUrl: entry.localLanUrl,
      ...(ctx.featureFlagToken ? { featureFlagToken: ctx.featureFlagToken } : {}),
      ...(actorToken ? { actorToken } : {}),
    });
  }

  return Response.json({ status: entry.status });
}

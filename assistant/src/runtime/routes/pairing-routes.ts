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
import { getLogger } from '../../util/logger.js';
import { httpError } from '../http-errors.js';

const log = getLogger('runtime-http');

export interface PairingHandlerContext {
  pairingStore: PairingStore;
  bearerToken: string | undefined;
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
      return Response.json({
        status: 'approved',
        bearerToken: ctx.bearerToken,
        gatewayUrl: entry.gatewayUrl,
        localLanUrl: entry.localLanUrl,
      });
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
    return Response.json({
      status: 'approved',
      bearerToken: entry.bearerToken,
      gatewayUrl: entry.gatewayUrl,
      localLanUrl: entry.localLanUrl,
    });
  }

  return Response.json({ status: entry.status });
}

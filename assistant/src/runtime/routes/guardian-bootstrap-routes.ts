/**
 * POST /v1/integrations/guardian/vellum/bootstrap
 *
 * Idempotent bootstrap endpoint for the vellum guardian channel.
 * Creates or confirms a guardianPrincipalId and channel='vellum'
 * guardian binding, then mints and returns an actor token bound
 * to (assistantId, guardianPrincipalId, deviceId).
 *
 * Only the hashed token is persisted.
 */

import { createHash } from 'node:crypto';

import { v4 as uuid } from 'uuid';

import {
  createBinding,
  getActiveBinding,
} from '../../memory/guardian-bindings.js';
import { getLogger } from '../../util/logger.js';
import { mintActorToken } from '../actor-token-service.js';
import {
  createActorTokenRecord,
  revokeByDeviceBinding,
} from '../actor-token-store.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../assistant-scope.js';
import { httpError } from '../http-errors.js';
import type { ServerWithRequestIP } from '../middleware/actor-token.js';

const log = getLogger('guardian-bootstrap');

/** Hash a device ID for storage (same pattern as approved-devices-store). */
function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

/**
 * Ensure a guardianPrincipalId exists for the vellum channel.
 * If a binding already exists, returns the existing guardianExternalUserId
 * as the principal. Otherwise creates a new binding with a fresh principal.
 */
function ensureGuardianPrincipal(assistantId: string): {
  guardianPrincipalId: string;
  isNew: boolean;
} {
  const existing = getActiveBinding(assistantId, 'vellum');
  if (existing) {
    return { guardianPrincipalId: existing.guardianExternalUserId, isNew: false };
  }

  // Mint a new principal ID for the vellum channel
  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  createBinding({
    assistantId,
    channel: 'vellum',
    guardianExternalUserId: guardianPrincipalId,
    guardianDeliveryChatId: 'local',
    guardianPrincipalId,
    verifiedVia: 'bootstrap',
    metadataJson: JSON.stringify({ bootstrappedAt: Date.now() }),
  });

  log.info({ assistantId, guardianPrincipalId }, 'Created vellum guardian principal via bootstrap');
  return { guardianPrincipalId, isNew: true };
}

/** Loopback addresses — used to gate the bootstrap endpoint to local-only. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Handle POST /v1/integrations/guardian/vellum/bootstrap
 *
 * Body: { platform: 'macos', deviceId: string }
 * Returns: { guardianPrincipalId, actorToken, isNew }
 *
 * This endpoint is loopback-only (macOS local use only). iOS devices
 * obtain actor tokens exclusively through the QR pairing flow.
 */
export async function handleGuardianBootstrap(req: Request, server: ServerWithRequestIP): Promise<Response> {
  // Reject proxied requests — bootstrap is local-only
  if (req.headers.get('x-forwarded-for')) {
    return httpError('FORBIDDEN', 'Bootstrap endpoint is local-only', 403);
  }

  // Reject non-loopback peers
  const peerIp = server.requestIP(req)?.address;
  if (!peerIp || !LOOPBACK_ADDRESSES.has(peerIp)) {
    return httpError('FORBIDDEN', 'Bootstrap endpoint is local-only', 403);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';

    if (!platform || !deviceId) {
      return httpError('BAD_REQUEST', 'Missing required fields: platform, deviceId', 400);
    }

    if (platform !== 'macos' && platform !== 'cli') {
      return httpError('BAD_REQUEST', 'Invalid platform. Bootstrap is macOS/CLI-only; iOS uses QR pairing.', 400);
    }

    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    const { guardianPrincipalId, isNew } = ensureGuardianPrincipal(assistantId);
    const hashedDeviceId = hashDeviceId(deviceId);

    // Revoke any existing active tokens for this device binding
    // so we maintain one-active-token-per-device
    revokeByDeviceBinding(assistantId, guardianPrincipalId, hashedDeviceId);

    // Mint a new actor token
    const { token, tokenHash, claims } = mintActorToken({
      assistantId,
      platform,
      deviceId,
      guardianPrincipalId,
    });

    // Store only the hash
    createActorTokenRecord({
      tokenHash,
      assistantId,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });

    log.info(
      { assistantId, platform, guardianPrincipalId, isNew },
      'Guardian bootstrap completed',
    );

    return Response.json({
      guardianPrincipalId,
      actorToken: token,
      isNew,
    });
  } catch (err) {
    log.error({ err }, 'Guardian bootstrap failed');
    return httpError('INTERNAL_ERROR', 'Internal server error', 500);
  }
}

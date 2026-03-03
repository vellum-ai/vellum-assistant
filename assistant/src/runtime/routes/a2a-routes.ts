/**
 * Runtime HTTP route handlers for A2A connection management.
 *
 * Exposes the A2A connection service methods as REST endpoints. All endpoints
 * accept explicit parameters in the request body/query — no session coupling.
 *
 * Internal endpoints (invite, redeem, approve, revoke, list connections) use
 * the existing runtime bearer auth. External endpoints (connect, verify,
 * status) are designed for peer-to-peer access and have their own auth model.
 */

import {
  approveConnection,
  generateInvite,
  initiateConnection,
  listConnectionsFiltered,
  redeemInvite,
  revokeConnection,
  sendMessage,
  submitVerificationCode,
  A2A_PROTOCOL_VERSION,
} from '../../a2a/a2a-connection-service.js';
import type { A2AMessageContent } from '../../a2a/a2a-message-schema.js';
import {
  a2aRateLimitResponse,
  codeVerificationLimiter,
  connectRequestLimiter,
  inviteRedemptionLimiter,
  statusPollingLimiter,
} from '../../a2a/a2a-rate-limiter.js';
import { getConnection } from '../../a2a/a2a-peer-connection-store.js';
import { getIngressPublicBaseUrl } from '../../config/env.js';
import { getLogger } from '../../util/logger.js';
import { httpError } from '../http-errors.js';

import type { A2APeerConnectionStatus } from '../../a2a/a2a-peer-connection-store.js';

const log = getLogger('a2a-routes');

// ---------------------------------------------------------------------------
// POST /v1/a2a/invite — Generate an invite for a peer
// ---------------------------------------------------------------------------

export async function handleA2AInvite(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const gatewayUrl = typeof body.gatewayUrl === 'string' ? body.gatewayUrl : '';
  if (!gatewayUrl) {
    return httpError('BAD_REQUEST', 'Missing required field: gatewayUrl', 400);
  }

  const expiresInMs = typeof body.expiresInMs === 'number' ? body.expiresInMs : undefined;
  const note = typeof body.note === 'string' ? body.note : undefined;
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

  const result = generateInvite({ gatewayUrl, expiresInMs, note, idempotencyKey });

  if (!result.ok) {
    if (result.reason === 'missing_gateway_url') {
      return httpError('BAD_REQUEST', 'Missing gateway URL', 400);
    }
    return httpError('INTERNAL_ERROR', 'Failed to generate invite', 500);
  }

  return Response.json({
    inviteCode: result.inviteCode,
    inviteId: result.inviteId,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/redeem — Validate and decode an invite code
// ---------------------------------------------------------------------------

export async function handleA2ARedeem(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : '';
  if (!inviteCode) {
    return httpError('BAD_REQUEST', 'Missing required field: inviteCode', 400);
  }

  // Rate limit by invite code (truncated for privacy in logs)
  const rlResult = inviteRedemptionLimiter.check(inviteCode);
  if (!rlResult.allowed) {
    log.warn({ inviteCode: inviteCode.slice(0, 8) + '...' }, 'Invite redemption rate limit hit');
    return a2aRateLimitResponse(rlResult);
  }

  const result = redeemInvite({ inviteCode });

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      malformed_invite: 400,
      invalid_or_expired: 404,
      already_redeemed: 409,
    };
    return httpError(
      result.reason === 'malformed_invite' ? 'BAD_REQUEST' : result.reason === 'already_redeemed' ? 'CONFLICT' : 'NOT_FOUND',
      result.reason,
      statusMap[result.reason] ?? 400,
    );
  }

  return Response.json({
    peerGatewayUrl: result.peerGatewayUrl,
    inviteId: result.inviteId,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/connect — Initiate a connection request (peer-facing)
// ---------------------------------------------------------------------------

export async function handleA2AConnect(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const peerGatewayUrl = typeof body.peerGatewayUrl === 'string' ? body.peerGatewayUrl : '';
  const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : '';
  const protocolVersion = typeof body.protocolVersion === 'string' ? body.protocolVersion : A2A_PROTOCOL_VERSION;
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : [];
  const peerAssistantId = typeof body.peerAssistantId === 'string' ? body.peerAssistantId : undefined;

  // Derive ownGatewayUrl server-side from config instead of trusting the
  // request body, so peers cannot forge it to bypass the self-loop guard.
  const ownGatewayUrl = getIngressPublicBaseUrl();

  if (!peerGatewayUrl) {
    return httpError('BAD_REQUEST', 'Missing required field: peerGatewayUrl', 400);
  }
  if (!inviteToken) {
    return httpError('BAD_REQUEST', 'Missing required field: inviteToken', 400);
  }

  // Rate limit by source IP (set by gateway proxy via X-Forwarded-For)
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rlResult = connectRequestLimiter.check(clientIp);
  if (!rlResult.allowed) {
    log.warn({ clientIp }, 'Connect request rate limit hit');
    return a2aRateLimitResponse(rlResult);
  }

  const result = initiateConnection({
    peerGatewayUrl,
    peerAssistantId,
    inviteToken,
    protocolVersion,
    capabilities,
    ownGatewayUrl,
  });

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      invalid_target: 400,
      version_mismatch: 400,
      invite_not_found: 404,
      invite_consumed: 409,
    };
    const codeMap: Record<string, 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT'> = {
      invalid_target: 'BAD_REQUEST',
      version_mismatch: 'BAD_REQUEST',
      invite_not_found: 'NOT_FOUND',
      invite_consumed: 'CONFLICT',
    };
    return httpError(
      codeMap[result.reason] ?? 'BAD_REQUEST',
      result.detail ?? result.reason,
      statusMap[result.reason] ?? 400,
    );
  }

  return Response.json({
    connectionId: result.connectionId,
    handshakeSessionId: result.handshakeSessionId,
  }, { status: 201 });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/approve — Approve or deny a pending connection
// ---------------------------------------------------------------------------

export async function handleA2AApprove(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
  const decision = typeof body.decision === 'string' ? body.decision : '';

  if (!connectionId) {
    return httpError('BAD_REQUEST', 'Missing required field: connectionId', 400);
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return httpError('BAD_REQUEST', 'decision must be "approve" or "deny"', 400);
  }

  const result = approveConnection({ connectionId, decision });

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      not_found: 404,
      invalid_state: 409,
      already_resolved: 409,
    };
    return httpError(
      result.reason === 'not_found' ? 'NOT_FOUND' : 'CONFLICT',
      result.reason,
      statusMap[result.reason] ?? 400,
    );
  }

  if (decision === 'approve' && 'verificationCode' in result) {
    return Response.json({
      verificationCode: result.verificationCode,
      connectionId: result.connectionId,
    });
  }

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/verify — Submit verification code (peer-facing)
// ---------------------------------------------------------------------------

export async function handleA2AVerify(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const peerIdentity = typeof body.peerIdentity === 'string' ? body.peerIdentity : '';

  if (!connectionId) {
    return httpError('BAD_REQUEST', 'Missing required field: connectionId', 400);
  }
  if (!code) {
    return httpError('BAD_REQUEST', 'Missing required field: code', 400);
  }
  if (!peerIdentity) {
    return httpError('BAD_REQUEST', 'Missing required field: peerIdentity', 400);
  }

  // Rate limit by connection ID
  const rlResult = codeVerificationLimiter.check(connectionId);
  if (!rlResult.allowed) {
    log.warn({ connectionId }, 'Code verification rate limit hit');
    return a2aRateLimitResponse(rlResult);
  }

  const result = submitVerificationCode({ connectionId, code, peerIdentity });

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      not_found: 404,
      invalid_code: 403,
      expired: 410,
      max_attempts: 429,
      invalid_state: 409,
      identity_mismatch: 403,
    };
    const codeMap: Record<string, 'NOT_FOUND' | 'FORBIDDEN' | 'GONE' | 'RATE_LIMITED' | 'CONFLICT'> = {
      not_found: 'NOT_FOUND',
      invalid_code: 'FORBIDDEN',
      expired: 'GONE',
      max_attempts: 'RATE_LIMITED',
      invalid_state: 'CONFLICT',
      identity_mismatch: 'FORBIDDEN',
    };
    return httpError(
      codeMap[result.reason] ?? 'BAD_REQUEST',
      result.reason,
      statusMap[result.reason] ?? 400,
    );
  }

  return Response.json({
    connectionId: result.connection.id,
    status: result.connection.status,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/revoke — Revoke a connection
// ---------------------------------------------------------------------------

export async function handleA2ARevoke(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
  if (!connectionId) {
    return httpError('BAD_REQUEST', 'Missing required field: connectionId', 400);
  }

  const result = revokeConnection({ connectionId });

  if (!result.ok) {
    return httpError('NOT_FOUND', result.reason, 404);
  }

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// GET /v1/a2a/connections — List connections
// ---------------------------------------------------------------------------

export function handleA2AListConnections(url: URL): Response {
  const statusParam = url.searchParams.get('status') as A2APeerConnectionStatus | null;

  const result = listConnectionsFiltered({
    status: statusParam ?? undefined,
  });

  return Response.json({ connections: result.connections });
}

// ---------------------------------------------------------------------------
// GET /v1/a2a/connections/:connectionId/status — Poll connection status
// ---------------------------------------------------------------------------

export function handleA2AConnectionStatus(connectionId: string): Response {
  // Rate limit by connection ID
  const rlResult = statusPollingLimiter.check(connectionId);
  if (!rlResult.allowed) {
    log.warn({ connectionId }, 'Status polling rate limit hit');
    return a2aRateLimitResponse(rlResult);
  }

  const connection = getConnection(connectionId);
  if (!connection) {
    return httpError('NOT_FOUND', 'Connection not found', 404);
  }

  return Response.json({
    connectionId: connection.id,
    status: connection.status,
    peerGatewayUrl: connection.peerGatewayUrl,
    protocolVersion: connection.protocolVersion,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/a2a/connections/:connectionId/messages — Send a message to a peer
// ---------------------------------------------------------------------------

export async function handleA2ASendMessage(req: Request, connectionId: string): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  // Validate content
  if (!body.content || typeof body.content !== 'object') {
    return httpError('BAD_REQUEST', 'Missing required field: content', 400);
  }

  const content = body.content as Record<string, unknown>;
  if (!content.type || typeof content.type !== 'string') {
    return httpError('BAD_REQUEST', 'Missing required field: content.type', 400);
  }

  // Build the typed content object
  let messageContent: A2AMessageContent;
  switch (content.type) {
    case 'text': {
      if (typeof content.text !== 'string') {
        return httpError('BAD_REQUEST', 'Missing required field: content.text for text content', 400);
      }
      messageContent = { type: 'text', text: content.text };
      break;
    }
    case 'structured_request': {
      if (typeof content.action !== 'string') {
        return httpError('BAD_REQUEST', 'Missing required field: content.action for structured_request', 400);
      }
      const params = (typeof content.params === 'object' && content.params !== null)
        ? content.params as Record<string, unknown>
        : {};
      messageContent = { type: 'structured_request', action: content.action, params };
      break;
    }
    case 'structured_response': {
      if (typeof content.action !== 'string') {
        return httpError('BAD_REQUEST', 'Missing required field: content.action for structured_response', 400);
      }
      const result = (typeof content.result === 'object' && content.result !== null)
        ? content.result as Record<string, unknown>
        : {};
      messageContent = {
        type: 'structured_response',
        action: content.action,
        result,
        success: content.success === true,
        error: typeof content.error === 'string' ? content.error : undefined,
      };
      break;
    }
    default:
      return httpError('BAD_REQUEST', `Unsupported content type: ${content.type}`, 400);
  }

  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : undefined;

  const sendResult = await sendMessage({
    connectionId,
    content: messageContent,
    correlationId,
  });

  if (!sendResult.ok) {
    const statusMap: Record<string, number> = {
      not_found: 404,
      not_active: 409,
      not_enabled: 403,
      no_credential: 500,
      delivery_failed: 502,
    };
    const codeMap: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR' | 'SERVICE_UNAVAILABLE'> = {
      not_found: 'NOT_FOUND',
      not_active: 'CONFLICT',
      not_enabled: 'FORBIDDEN',
      no_credential: 'INTERNAL_ERROR',
      delivery_failed: 'SERVICE_UNAVAILABLE',
    };
    return httpError(
      codeMap[sendResult.reason] ?? 'INTERNAL_ERROR',
      sendResult.detail ?? sendResult.reason,
      statusMap[sendResult.reason] ?? 500,
    );
  }

  return Response.json({
    messageId: sendResult.messageId,
    conversationId: sendResult.conversationId,
  }, { status: 202 });
}

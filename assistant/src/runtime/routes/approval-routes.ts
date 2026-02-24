/**
 * Route handlers for standalone approval endpoints.
 *
 * These endpoints resolve pending confirmations, secrets, and trust rules
 * by requestId — orthogonal to message sending.
 */
import * as pendingInteractions from '../pending-interactions.js';
import { getConversationByKey } from '../../memory/conversation-key-store.js';
import { addRule } from '../../permissions/trust-store.js';
import { getTool } from '../../tools/registry.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('approval-routes');

/**
 * POST /v1/confirm — resolve a pending confirmation by requestId.
 */
export async function handleConfirm(req: Request): Promise<Response> {
  const body = await req.json() as {
    requestId?: string;
    decision?: string;
  };

  const { requestId, decision } = body;

  if (!requestId || typeof requestId !== 'string') {
    return Response.json({ error: 'requestId is required' }, { status: 400 });
  }

  if (decision !== 'allow' && decision !== 'deny') {
    return Response.json(
      { error: 'decision must be "allow" or "deny"' },
      { status: 400 },
    );
  }

  const interaction = pendingInteractions.resolve(requestId);
  if (!interaction) {
    return Response.json(
      { error: 'No pending interaction found for this requestId' },
      { status: 404 },
    );
  }

  interaction.session.handleConfirmationResponse(requestId, decision);
  return Response.json({ accepted: true });
}

/**
 * POST /v1/secret — resolve a pending secret request by requestId.
 */
export async function handleSecret(req: Request): Promise<Response> {
  const body = await req.json() as {
    requestId?: string;
    value?: string;
    delivery?: string;
  };

  const { requestId, value, delivery } = body;

  if (!requestId || typeof requestId !== 'string') {
    return Response.json({ error: 'requestId is required' }, { status: 400 });
  }

  if (delivery !== undefined && delivery !== 'store' && delivery !== 'transient_send') {
    return Response.json(
      { error: 'delivery must be "store" or "transient_send"' },
      { status: 400 },
    );
  }

  const interaction = pendingInteractions.resolve(requestId);
  if (!interaction) {
    return Response.json(
      { error: 'No pending interaction found for this requestId' },
      { status: 404 },
    );
  }

  interaction.session.handleSecretResponse(
    requestId,
    value,
    delivery as 'store' | 'transient_send' | undefined,
  );
  return Response.json({ accepted: true });
}

/**
 * POST /v1/trust-rules — add a trust rule for a pending confirmation.
 *
 * Does NOT resolve the confirmation itself (the client still needs to
 * POST /v1/confirm to approve/deny). Validates the pattern and scope
 * against the server-provided allowlist options from the original
 * confirmation_request.
 */
export async function handleTrustRule(req: Request): Promise<Response> {
  const body = await req.json() as {
    requestId?: string;
    pattern?: string;
    scope?: string;
    decision?: string;
  };

  const { requestId, pattern, scope, decision } = body;

  if (!requestId || typeof requestId !== 'string') {
    return Response.json({ error: 'requestId is required' }, { status: 400 });
  }

  if (!pattern || typeof pattern !== 'string') {
    return Response.json({ error: 'pattern is required' }, { status: 400 });
  }

  if (!scope || typeof scope !== 'string') {
    return Response.json({ error: 'scope is required' }, { status: 400 });
  }

  if (decision !== 'allow' && decision !== 'deny') {
    return Response.json({ error: 'decision must be "allow" or "deny"' }, { status: 400 });
  }

  // Look up without removing — trust rule doesn't resolve the confirmation
  const interaction = pendingInteractions.get(requestId);
  if (!interaction) {
    return Response.json(
      { error: 'No pending interaction found for this requestId' },
      { status: 404 },
    );
  }

  if (!interaction.confirmationDetails) {
    return Response.json(
      { error: 'No confirmation details available for this request' },
      { status: 409 },
    );
  }

  const confirmation = interaction.confirmationDetails;

  if (confirmation.persistentDecisionsAllowed === false) {
    return Response.json(
      { error: 'Persistent trust rules are not allowed for this tool invocation' },
      { status: 403 },
    );
  }

  // Validate pattern against server-provided allowlist options
  const validPatterns = (confirmation.allowlistOptions ?? []).map((o) => o.pattern);
  if (!validPatterns.includes(pattern)) {
    return Response.json(
      { error: 'pattern does not match any server-provided allowlist option' },
      { status: 403 },
    );
  }

  // Validate scope against server-provided scope options
  const validScopes = (confirmation.scopeOptions ?? []).map((o) => o.scope);
  if (!validScopes.includes(scope)) {
    return Response.json(
      { error: 'scope does not match any server-provided scope option' },
      { status: 403 },
    );
  }

  try {
    const tool = getTool(confirmation.toolName);
    const executionTarget = tool?.origin === 'skill' ? confirmation.executionTarget : undefined;
    addRule(confirmation.toolName, pattern, scope, decision, undefined, {
      executionTarget,
    });
    log.info(
      { tool: confirmation.toolName, pattern, scope, decision, requestId },
      'Trust rule added via HTTP (bound to pending confirmation)',
    );
    return Response.json({ accepted: true });
  } catch (err) {
    log.error({ err }, 'Failed to add trust rule');
    return Response.json({ error: 'Failed to add trust rule' }, { status: 500 });
  }
}

/**
 * GET /v1/pending-interactions?conversationKey=...
 *
 * Returns pending confirmations and secrets for a conversation, allowing
 * polling-based clients (like the CLI) to discover approval requests
 * without SSE.
 */
export function handleListPendingInteractions(url: URL): Response {
  const conversationKey = url.searchParams.get('conversationKey');
  const conversationId = url.searchParams.get('conversationId');

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
  } else {
    return Response.json(
      { error: 'conversationKey or conversationId query parameter is required' },
      { status: 400 },
    );
  }

  if (!resolvedConversationId) {
    return Response.json({ pendingConfirmation: null, pendingSecret: null });
  }

  const interactions = pendingInteractions.getByConversation(resolvedConversationId);

  const confirmation = interactions.find((i) => i.kind === 'confirmation');
  const secret = interactions.find((i) => i.kind === 'secret');

  return Response.json({
    pendingConfirmation: confirmation
      ? {
          requestId: confirmation.requestId,
          toolName: confirmation.confirmationDetails?.toolName,
          toolUseId: confirmation.requestId,
          input: confirmation.confirmationDetails?.input ?? {},
          riskLevel: confirmation.confirmationDetails?.riskLevel ?? 'unknown',
          executionTarget: confirmation.confirmationDetails?.executionTarget,
          allowlistOptions: confirmation.confirmationDetails?.allowlistOptions?.map((o) => ({
            label: o.label,
            pattern: o.pattern,
          })),
          scopeOptions: confirmation.confirmationDetails?.scopeOptions,
          persistentDecisionsAllowed: confirmation.confirmationDetails?.persistentDecisionsAllowed,
        }
      : null,
    pendingSecret: secret
      ? {
          requestId: secret.requestId,
        }
      : null,
  });
}

/**
 * Route handlers for run creation, status, decisions, and trust rules.
 */
import * as runsStore from '../../memory/runs-store.js';
import { addRule } from '../../permissions/trust-store.js';
import { getTool } from '../../tools/registry.js';
import { getLogger } from '../../util/logger.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import { parseSendRequest, isValidationError } from './send-validation.js';

const log = getLogger('runtime-http');

export async function handleCreateRun(
  req: Request,
  runOrchestrator: RunOrchestrator,
): Promise<Response> {
  const parsed = await parseSendRequest(req);
  if (isValidationError(parsed)) return parsed;

  const { conversationKey, conversationId, content, attachmentIds, sourceChannel } = parsed;

  log.info({ endpoint: 'POST /v1/runs', conversationKey }, 'Send attempt');

  try {
    const run = await runOrchestrator.startRun(
      conversationId,
      content,
      attachmentIds,
      { sourceChannel },
    );
    return Response.json({
      id: run.id,
      status: run.status,
      messageId: run.messageId,
      createdAt: new Date(run.createdAt).toISOString(),
    }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'Session is already processing a message') {
      log.warn({ endpoint: 'POST /v1/runs', conversationKey }, 'Send rejected — session busy');
      return Response.json(
        { error: 'Session is busy processing another message. Please retry.' },
        { status: 409 },
      );
    }
    throw err;
  }
}

export function handleGetRun(
  runId: string,
  runOrchestrator: RunOrchestrator,
): Response {
  const run = runOrchestrator.getRun(runId);
  if (!run) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  return Response.json({
    id: run.id,
    status: run.status,
    messageId: run.messageId,
    pendingConfirmation: run.pendingConfirmation,
    pendingSecret: run.pendingSecret,
    error: run.error,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
  });
}

export async function handleRunDecision(
  runId: string,
  req: Request,
  runOrchestrator: RunOrchestrator,
): Promise<Response> {
  const run = runOrchestrator.getRun(runId);
  if (!run) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  const body = await req.json() as { decision?: string };
  const { decision } = body;

  if (decision !== 'allow' && decision !== 'deny') {
    return Response.json(
      { error: 'decision must be "allow" or "deny"' },
      { status: 400 },
    );
  }

  const result = runOrchestrator.submitDecision(runId, decision);
  if (result === 'run_not_found') {
    return Response.json(
      { error: 'Run not found' },
      { status: 404 },
    );
  }
  if (result === 'no_pending_decision') {
    return Response.json(
      { error: 'No confirmation pending for this run' },
      { status: 409 },
    );
  }

  return Response.json({ accepted: true });
}

/**
 * Add a trust rule, but ONLY if there is a pending confirmation for the
 * given run.  The caller-supplied pattern and scope are validated against
 * the server-generated allowlist/scope options that were sent with the
 * original confirmation_request — preventing arbitrary rule injection.
 */
export async function handleAddTrustRule(
  runId: string,
  req: Request,
): Promise<Response> {
  const run = runsStore.getRun(runId);
  if (!run) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  if (run.status !== 'needs_confirmation' || !run.pendingConfirmation) {
    return Response.json(
      { error: 'No confirmation pending for this run' },
      { status: 409 },
    );
  }

  if (run.pendingConfirmation.persistentDecisionsAllowed === false) {
    return Response.json(
      { error: 'Persistent trust rules are not allowed for this tool invocation' },
      { status: 403 },
    );
  }

  const body = await req.json() as {
    pattern?: string;
    scope?: string;
    decision?: string;
  };

  const { pattern, scope, decision } = body;

  if (!pattern || typeof pattern !== 'string') {
    return Response.json({ error: 'pattern is required' }, { status: 400 });
  }
  if (!scope || typeof scope !== 'string') {
    return Response.json({ error: 'scope is required' }, { status: 400 });
  }
  if (decision !== 'allow' && decision !== 'deny') {
    return Response.json({ error: 'decision must be "allow" or "deny"' }, { status: 400 });
  }

  const confirmation = run.pendingConfirmation;

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
    // Only persist executionTarget for skill-origin tools — core tools don't
    // set it in their PolicyContext, so a persisted value would prevent the
    // rule from ever matching on subsequent permission checks.
    const tool = getTool(confirmation.toolName);
    const executionTarget = tool?.origin === 'skill' ? confirmation.executionTarget : undefined;
    addRule(confirmation.toolName, pattern, scope, decision, undefined, {
      executionTarget,
    });
    log.info(
      { tool: confirmation.toolName, pattern, scope, decision, runId },
      'Trust rule added via HTTP (bound to pending confirmation)',
    );
    return Response.json({ accepted: true });
  } catch (err) {
    log.error({ err }, 'Failed to add trust rule');
    return Response.json({ error: 'Failed to add trust rule' }, { status: 500 });
  }
}

export async function handleRunSecret(
  runId: string,
  req: Request,
  runOrchestrator: RunOrchestrator,
): Promise<Response> {
  const run = runOrchestrator.getRun(runId);
  if (!run) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  const body = await req.json() as {
    value?: string;
    delivery?: string;
  };

  const { value, delivery } = body;

  if (delivery !== undefined && delivery !== 'store' && delivery !== 'transient_send') {
    return Response.json(
      { error: 'delivery must be "store" or "transient_send"' },
      { status: 400 },
    );
  }

  const result = runOrchestrator.submitSecret(
    runId,
    value,
    delivery as 'store' | 'transient_send' | undefined,
  );
  if (result === 'run_not_found') {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }
  if (result === 'no_pending_secret') {
    return Response.json(
      { error: 'No secret pending for this run' },
      { status: 409 },
    );
  }

  return Response.json({ accepted: true });
}

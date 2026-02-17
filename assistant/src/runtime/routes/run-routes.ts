/**
 * Route handlers for run creation, status, decisions, and trust rules.
 */
import { getOrCreateConversation } from '../../memory/conversation-key-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import { addRule } from '../../permissions/trust-store.js';
import { getLogger } from '../../util/logger.js';
import type { RunOrchestrator } from '../run-orchestrator.js';

const log = getLogger('runtime-http');

export async function handleCreateRun(
  assistantId: string,
  req: Request,
  runOrchestrator: RunOrchestrator,
): Promise<Response> {
  const body = await req.json() as {
    conversationKey?: string;
    content?: string;
    attachmentIds?: string[];
  };

  const { conversationKey, content, attachmentIds } = body;

  if (!conversationKey) {
    return Response.json({ error: 'conversationKey is required' }, { status: 400 });
  }

  if (content !== undefined && content !== null && typeof content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
  }

  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return Response.json(
        { error: `Attachment IDs not found: ${missing.join(', ')}` },
        { status: 400 },
      );
    }
  }

  const mapping = getOrCreateConversation(assistantId, conversationKey);

  try {
    const run = await runOrchestrator.startRun(
      assistantId,
      mapping.conversationId,
      content ?? '',
      hasAttachments ? attachmentIds : undefined,
    );
    return Response.json({
      id: run.id,
      status: run.status,
      messageId: run.messageId,
      createdAt: new Date(run.createdAt).toISOString(),
    }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'Session is already processing a message') {
      return Response.json(
        { error: 'Session is busy processing another message. Please retry.' },
        { status: 409 },
      );
    }
    throw err;
  }
}

export function handleGetRun(
  assistantId: string,
  runId: string,
  runOrchestrator: RunOrchestrator,
): Response {
  const run = runOrchestrator.getRun(runId);
  if (!run || run.assistantId !== assistantId) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  return Response.json({
    id: run.id,
    status: run.status,
    messageId: run.messageId,
    pendingConfirmation: run.pendingConfirmation,
    error: run.error,
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
  });
}

export async function handleRunDecision(
  assistantId: string,
  runId: string,
  req: Request,
  runOrchestrator: RunOrchestrator,
): Promise<Response> {
  const run = runOrchestrator.getRun(runId);
  if (!run || run.assistantId !== assistantId) {
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

export async function handleAddTrustRule(req: Request): Promise<Response> {
  const body = await req.json() as {
    toolName?: string;
    pattern?: string;
    scope?: string;
    decision?: string;
  };

  const { toolName, pattern, scope, decision } = body;

  if (!toolName || typeof toolName !== 'string') {
    return Response.json({ error: 'toolName is required' }, { status: 400 });
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

  try {
    addRule(toolName, pattern, scope, decision);
    log.info({ tool: toolName, pattern, scope, decision }, 'Trust rule added via HTTP');
    return Response.json({ accepted: true });
  } catch (err) {
    log.error({ err }, 'Failed to add trust rule');
    return Response.json({ error: 'Failed to add trust rule' }, { status: 500 });
  }
}

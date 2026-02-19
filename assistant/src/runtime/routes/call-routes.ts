/**
 * Runtime HTTP route handlers for the call API.
 *
 * POST   /v1/calls/start              — initiate a new call
 * GET    /v1/calls/:callSessionId      — get call status
 * POST   /v1/calls/:callSessionId/cancel — cancel a call
 * POST   /v1/calls/:callSessionId/answer — answer a pending question
 */

import { startCall, getCallStatus, cancelCall, answerCall } from '../../calls/call-domain.js';
import { getLogger } from '../../util/logger.js';
import { getConfig } from '../../config/loader.js';

const log = getLogger('call-routes');

/**
 * POST /v1/calls/start
 *
 * Body: { phoneNumber: string; task: string; context?: string; conversationId: string }
 */
export async function handleStartCall(req: Request): Promise<Response> {
  if (!getConfig().calls.enabled) {
    return Response.json(
      { error: 'Calls feature is disabled via configuration. Set calls.enabled to true to use this feature.' },
      { status: 403 },
    );
  }

  const body = await req.json() as {
    phoneNumber?: string;
    task?: string;
    context?: string;
    conversationId?: string;
  };

  if (!body.conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }

  const result = await startCall({
    phoneNumber: body.phoneNumber ?? '',
    task: body.task ?? '',
    context: body.context,
    conversationId: body.conversationId,
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status ?? 500 });
  }

  return Response.json({
    callSessionId: result.session.id,
    callSid: result.callSid,
    status: result.session.status,
    toNumber: result.session.toNumber,
    fromNumber: result.session.fromNumber,
  }, { status: 201 });
}

/**
 * GET /v1/calls/:callSessionId
 */
export function handleGetCallStatus(callSessionId: string): Response {
  const result = getCallStatus(callSessionId);

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status ?? 500 });
  }

  const { session } = result;
  return Response.json({
    callSessionId: session.id,
    conversationId: session.conversationId,
    status: session.status,
    toNumber: session.toNumber,
    fromNumber: session.fromNumber,
    provider: session.provider,
    providerCallSid: session.providerCallSid,
    task: session.task,
    startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    lastError: session.lastError,
    pendingQuestion: result.pendingQuestion ?? null,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  });
}

/**
 * POST /v1/calls/:callSessionId/cancel
 *
 * Body: { reason?: string }
 */
export async function handleCancelCall(req: Request, callSessionId: string): Promise<Response> {
  let reason: string | undefined;
  try {
    const body = await req.json() as { reason?: string };
    reason = body.reason;
  } catch {
    // Empty body is fine
  }

  const result = await cancelCall({ callSessionId, reason });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status ?? 500 });
  }

  return Response.json({
    callSessionId: result.session.id,
    status: result.session.status,
  });
}

/**
 * POST /v1/calls/:callSessionId/answer
 *
 * Body: { answer: string }
 */
export async function handleAnswerCall(req: Request, callSessionId: string): Promise<Response> {
  const body = await req.json() as { answer?: string };

  const result = await answerCall({
    callSessionId,
    answer: body.answer ?? '',
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status ?? 500 });
  }

  return Response.json({ ok: true, questionId: result.questionId });
}

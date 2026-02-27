/**
 * Shared helper for minting scoped approval grants when a guardian-action
 * request is resolved with tool metadata.
 *
 * Used by both the channel inbound path (inbound-message-handler.ts) and
 * the desktop/IPC path (session-process.ts) to ensure grants are minted
 * consistently regardless of which channel the guardian answers on.
 */

import type { GuardianActionRequest } from '../memory/guardian-action-store.js';
import { createScopedApprovalGrant } from '../memory/scoped-approval-grants.js';
import { getLogger } from '../util/logger.js';
import { parseApprovalDecision } from './channel-approval-parser.js';

const log = getLogger('guardian-action-grant-minter');

/** TTL for scoped approval grants minted on guardian-action answer resolution. */
export const GUARDIAN_ACTION_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Mint a `tool_signature` scoped grant when a guardian-action request is
 * resolved and the request carries tool metadata (toolName + inputDigest).
 *
 * Skips silently when:
 *   - The resolved request has no toolName/inputDigest (informational consult).
 *   - The guardian's answer is not an explicit approval (fail-closed).
 *
 * Fails silently on error -- grant minting is best-effort and must never
 * block the guardian-action answer flow.
 */
export function tryMintGuardianActionGrant(params: {
  resolvedRequest: GuardianActionRequest;
  answerText: string;
  decisionChannel: string;
  guardianExternalUserId?: string;
}): void {
  const { resolvedRequest, answerText, decisionChannel, guardianExternalUserId } = params;

  // Only mint for requests that carry tool metadata -- informational
  // ASK_GUARDIAN consults without tool context do not produce grants.
  if (!resolvedRequest.toolName || !resolvedRequest.inputDigest) {
    return;
  }

  // Gate on explicit affirmative guardian decisions (fail-closed).
  // Only mint when the deterministic parser recognises an approval keyword
  // ("yes", "approve", "allow", "go ahead", etc.).  Unrecognised text
  // (e.g. "nope", "don't do that") is treated as non-approval and skipped,
  // preventing ambiguous answers from producing grants.
  const decision = parseApprovalDecision(answerText);
  if (decision?.action !== 'approve_once' && decision?.action !== 'approve_always') {
    log.info(
      {
        event: 'guardian_action_grant_skipped_no_approval',
        toolName: resolvedRequest.toolName,
        requestId: resolvedRequest.id,
        answerText,
        parsedAction: decision?.action ?? null,
        decisionChannel,
      },
      'Skipped grant minting: guardian answer not classified as explicit approval',
    );
    return;
  }

  try {
    createScopedApprovalGrant({
      assistantId: resolvedRequest.assistantId,
      scopeMode: 'tool_signature',
      toolName: resolvedRequest.toolName,
      inputDigest: resolvedRequest.inputDigest,
      requestChannel: resolvedRequest.sourceChannel,
      decisionChannel,
      executionChannel: null,
      conversationId: resolvedRequest.sourceConversationId,
      callSessionId: resolvedRequest.callSessionId,
      guardianExternalUserId: guardianExternalUserId ?? null,
      expiresAt: new Date(Date.now() + GUARDIAN_ACTION_GRANT_TTL_MS).toISOString(),
    });

    log.info(
      {
        event: 'guardian_action_grant_minted',
        toolName: resolvedRequest.toolName,
        requestId: resolvedRequest.id,
        callSessionId: resolvedRequest.callSessionId,
        decisionChannel,
      },
      'Minted scoped approval grant for guardian-action answer resolution',
    );
  } catch (err) {
    log.error(
      { err, toolName: resolvedRequest.toolName, requestId: resolvedRequest.id },
      'Failed to mint scoped approval grant for guardian-action (non-fatal)',
    );
  }
}

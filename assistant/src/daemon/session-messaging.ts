/**
 * Session messaging methods: enqueue, persistUserMessage,
 * redirectToSecurePrompt, and queue/confirmation helpers.
 *
 * Extracted from Session to keep the class focused on coordination.
 */

import { v4 as uuid } from 'uuid';
import type { Message } from '../providers/types.js';
import type { ServerMessage, UserMessageAttachment } from './ipc-protocol.js';
import { createUserMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import type { SecretPrompter } from '../permissions/secret-prompter.js';
import type { MessageQueue } from './session-queue-manager.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('session-messaging');

// ── Context Interface ────────────────────────────────────────────────

export interface MessagingSessionContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
}

// ── enqueueMessage ───────────────────────────────────────────────────

export function enqueueMessage(
  ctx: MessagingSessionContext,
  content: string,
  attachments: UserMessageAttachment[],
  onEvent: (msg: ServerMessage) => void,
  requestId: string,
  activeSurfaceId?: string,
  currentPage?: string,
): { queued: boolean; rejected?: boolean; requestId: string } {
  if (!ctx.processing) {
    return { queued: false, requestId };
  }

  const pushed = ctx.queue.push({ content, attachments, requestId, onEvent, activeSurfaceId, currentPage });
  if (!pushed) {
    return { queued: false, rejected: true, requestId };
  }
  return { queued: true, requestId };
}

// ── persistUserMessage ───────────────────────────────────────────────

export function persistUserMessage(
  ctx: MessagingSessionContext,
  content: string,
  attachments: UserMessageAttachment[],
  requestId?: string,
): string {
  if (ctx.processing) {
    throw new Error('Session is already processing a message');
  }

  if (!content.trim() && attachments.length === 0) {
    throw new Error('Message content or attachments are required');
  }

  const reqId = requestId ?? uuid();
  ctx.currentRequestId = reqId;
  ctx.processing = true;
  ctx.abortController = new AbortController();

  const userMessage = createUserMessage(content, attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    data: attachment.data,
    extractedText: attachment.extractedText,
  })));
  ctx.messages.push(userMessage);

  try {
    const persistedUserMessage = conversationStore.addMessage(
      ctx.conversationId,
      'user',
      JSON.stringify(userMessage.content),
    );

    if (!persistedUserMessage.id) {
      throw new Error('Failed to persist user message');
    }

    return persistedUserMessage.id;
  } catch (err) {
    ctx.messages.pop();
    ctx.processing = false;
    ctx.abortController = null;
    ctx.currentRequestId = undefined;
    throw err;
  }
}

// ── redirectToSecurePrompt ───────────────────────────────────────────

export function redirectToSecurePrompt(
  conversationId: string,
  secretPrompter: SecretPrompter,
  detectedTypes: string[],
  onComplete?: () => void,
): void {
  const service = 'detected';
  const field = detectedTypes.join(',');
  secretPrompter.prompt(
    service, field,
    'Secure Credential Entry',
    'Your message contained a secret. Please enter it here instead — it will be stored securely and never sent to the AI.',
    undefined, conversationId,
  ).then(async (result) => {
    if (!result.value) return;

    const { setSecureKey } = await import('../security/secure-keys.js');
    const { upsertCredentialMetadata } = await import('../tools/credentials/metadata-store.js');

    if (result.delivery === 'transient_send') {
      const { credentialBroker } = await import('../tools/credentials/broker.js');
      credentialBroker.injectTransient(service, field, result.value);
      try { upsertCredentialMetadata(service, field, {}); } catch (e) { log.debug({ err: e, service, field }, 'Non-critical credential metadata upsert failed'); }
      log.info({ service, field, delivery: 'transient_send' }, 'Ingress redirect: transient credential injected');
    } else {
      const key = `credential:${service}:${field}`;
      const stored = setSecureKey(key, result.value);
      if (stored) {
        try { upsertCredentialMetadata(service, field, {}); } catch (e) { log.debug({ err: e, service, field }, 'Non-critical credential metadata upsert failed'); }
        log.info({ service, field }, 'Ingress redirect: credential stored');
      } else {
        log.warn({ service, field }, 'Ingress redirect: secure storage write failed');
      }
    }
  }).catch(() => { /* prompt timeout or cancel is fine */ }).finally(() => {
    onComplete?.();
  });
}

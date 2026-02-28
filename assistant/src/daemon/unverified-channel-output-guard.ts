import type { GuardianRuntimeContext } from './session-runtime-assembly.js';
import type { ContentBlock } from '../providers/types.js';

export interface GuardedAssistantContent {
  content: ContentBlock[];
  sanitized: boolean;
  reason?: 'guardian_relay_claim';
}

const GUARDIAN_RELAY_PATTERNS: readonly RegExp[] = [
  /\bthey claim to be you\b/i,
  /\bsomeone on (telegram|sms|whatsapp|slack|email)\b/i,
  /\bhas been forwarded to (the )?guardian\b/i,
  /\bguardian (approved|denied|rejected)\b/i,
  /\bapproved it\b/i,
];

function looksLikeGuardianRelayClaim(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;

  if (GUARDIAN_RELAY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const mentionsVerifiedGuardian = /\bverified guardian\b/i.test(normalized);
  const asksPermission = /\bis it (ok|okay) to\b/i.test(normalized);
  if (mentionsVerifiedGuardian && asksPermission) {
    return true;
  }

  return false;
}

function buildSafeUnverifiedReply(ctx: GuardianRuntimeContext): string {
  if (ctx.denialReason === 'no_identity') {
    return 'I can\'t request or accept guardian approval from this channel because the sender identity could not be verified. Please message from a verifiable guardian account for this channel.';
  }

  return 'I can\'t request or accept guardian approval in this channel because no guardian is currently verified for it. Please complete guardian verification for this channel first.';
}

export function guardUnverifiedChannelAssistantOutput(
  content: ContentBlock[],
  guardianContext?: GuardianRuntimeContext | null,
): GuardedAssistantContent {
  if (!guardianContext || guardianContext.actorRole !== 'unverified_channel') {
    return { content, sanitized: false };
  }

  const hasRelayClaim = content.some(
    (block) => block.type === 'text' && looksLikeGuardianRelayClaim(block.text),
  );

  if (!hasRelayClaim) {
    return { content, sanitized: false };
  }

  const replacementText = buildSafeUnverifiedReply(guardianContext);
  const guarded: ContentBlock[] = [];
  let insertedReplacement = false;

  for (const block of content) {
    if (block.type === 'text') {
      if (!insertedReplacement) {
        guarded.push({ type: 'text', text: replacementText });
        insertedReplacement = true;
      }
      continue;
    }
    guarded.push(block);
  }

  if (!insertedReplacement) {
    guarded.push({ type: 'text', text: replacementText });
  }

  return {
    content: guarded,
    sanitized: true,
    reason: 'guardian_relay_claim',
  };
}


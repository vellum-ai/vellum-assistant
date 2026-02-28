// Guardian invite intent resolution for deterministic first-turn routing.
// Exports `resolveGuardianInviteIntent` as the single public entry point.
// When a guardian invite management request is detected, the session pipeline
// rewrites the message to force immediate entry into the trusted-contacts
// skill flow, bypassing the normal agent loop's tendency to produce conceptual
// preambles before loading the skill.

export type GuardianInviteIntentResult =
  | { kind: 'none' }
  | { kind: 'invite_management'; rewrittenContent: string; action?: 'create' | 'list' | 'revoke' | 'voice_create' | 'voice_list' | 'voice_revoke' };

// ── Direct invite patterns ────────────────────────────────────────────────
// These capture imperative requests to manage Telegram invite links.

const CREATE_INVITE_PATTERNS: RegExp[] = [
  /\bcreate\s+(?:an?\s+)?(?:telegram\s+)?invite\s*(?:link)?\b/i,
  /\binvite\s+(?:someone|somebody|a\s+friend|a\s+person)\s+(?:on|to|via|through)\s+telegram\b/i,
  /\b(?:make|generate|get)\s+(?:a\s+|an\s+)?(?:telegram\s+)?invite\s*(?:link)?\b/i,
  /\btelegram\s+invite\s*(?:link)?\b/i,
  /\bsend\s+(?:a\s+|an\s+)?invite\s+(?:link\s+)?(?:on|for|via|through)\s+telegram\b/i,
  /\bshare\s+(?:a\s+|an\s+)?(?:telegram\s+)?invite\s*(?:link)?\b/i,
  /\binvite\s+(?:link\s+)?for\s+telegram\b/i,
];

// ── Voice invite patterns ─────────────────────────────────────────────────
// These capture imperative requests to manage voice (phone call) invite codes.

const CREATE_VOICE_INVITE_PATTERNS: RegExp[] = [
  /\bcreate\s+(?:an?\s+)?voice\s+invite\b/i,
  /\bvoice\s+invite\s+(?:for|to)\s+\+?\d/i,
  /\b(?:make|generate|get|set\s+up)\s+(?:a\s+|an\s+)?voice\s+invite\b/i,
  /\binvite\s+(?:someone|somebody|a\s+friend|a\s+person)\s+(?:on|to|via|through|by)\s+(?:phone|voice|call)\b/i,
  /\b(?:create|make|generate|get|set\s+up)\s+(?:a\s+|an\s+)?(?:phone|call)\s+invite\b/i,
  /\binvite\s+.*(?:phone|voice|call)\s*(?:code)?\b/i,
  /\b(?:phone|voice|call)\s+invite\s*(?:code)?\b/i,
  /\blet\s+.*\s+call\s+(?:in|me)\b/i,
];

const LIST_INVITE_PATTERNS: RegExp[] = [
  /\b(?:show|list|view|see|display)\s+(?:my\s+)?(?:active\s+)?invite(?:s|\s*links?)\b/i,
  /\b(?:show|list|view|see|display)\s+(?:my\s+)?(?:telegram\s+)?invite(?:s|\s*links?)\b/i,
  /\bwhat\s+invite(?:s|\s*links?)\s+(?:do\s+I\s+have|are\s+active|exist)\b/i,
  /\bhow\s+many\s+invite(?:s|\s*links?)\b/i,
];

const LIST_VOICE_INVITE_PATTERNS: RegExp[] = [
  /\b(?:show|list|view|see|display)\s+(?:my\s+)?(?:active\s+)?voice\s+invite(?:s)?\b/i,
  /\b(?:show|list|view|see|display)\s+(?:my\s+)?(?:phone|call)\s+invite(?:s)?\b/i,
  /\bwhat\s+voice\s+invite(?:s)?\s+(?:do\s+I\s+have|are\s+active|exist)\b/i,
];

const REVOKE_INVITE_PATTERNS: RegExp[] = [
  /\b(?:revoke|cancel|disable|invalidate|delete|remove)\s+(?:the\s+|my\s+|an?\s+)?invite\s*(?:link)?\b/i,
  /\b(?:revoke|cancel|disable|invalidate|delete|remove)\s+(?:the\s+|my\s+|an?\s+)?(?:telegram\s+)?invite\s*(?:link)?\b/i,
  /\binvite\s*(?:link)?\s+(?:revoke|cancel|disable|invalidate|delete|remove)\b/i,
];

const REVOKE_VOICE_INVITE_PATTERNS: RegExp[] = [
  /\b(?:revoke|cancel|disable|invalidate|delete|remove)\s+(?:the\s+|my\s+|an?\s+)?voice\s+invite\b/i,
  /\b(?:revoke|cancel|disable|invalidate|delete|remove)\s+(?:the\s+|my\s+|an?\s+)?(?:phone|call)\s+invite\b/i,
  /\bvoice\s+invite\s+(?:revoke|cancel|disable|invalidate|delete|remove)\b/i,
];

// ── Conceptual / question patterns ──────────────────────────────────────
// These indicate the user is asking *about* invites rather than requesting
// to manage them. Return passthrough for these.

const CONCEPTUAL_PATTERNS: RegExp[] = [
  /^\s*(?:how|what|why|when|where|who|which)\b.*\binvite/i,
  /\bwhat\s+(?:is|are)\s+(?:an?\s+)?invite\s*(?:link)?\b/i,
  /\bhow\s+(?:do|does|can)\s+(?:invite|invitation)s?\s+work\b/i,
  /\bexplain\s+(?:the\s+)?invite\b/i,
  /\btell\s+me\s+about\s+invite\b/i,
];

/** Common polite/filler words stripped before checking intent-only status. */
const FILLER_PATTERN =
  /\b(please|pls|plz|can\s+you|could\s+you|would\s+you|now|right\s+now|thanks|thank\s+you|thx|ty|for\s+me|ok(ay)?|hey|hi|hello|just|i\s+want\s+to|i'd\s+like\s+to|i\s+need\s+to|let's|let\s+me)\b/gi;

// ── Internal helpers ─────────────────────────────────────────────────────

function isConceptualQuestion(text: string): boolean {
  const cleaned = text.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, '');
  // Allow actionable requests through even though they start with
  // question-like words — these are imperative invite management requests.
  if (LIST_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  if (LIST_VOICE_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  if (CREATE_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  if (CREATE_VOICE_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  if (REVOKE_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  if (REVOKE_VOICE_INVITE_PATTERNS.some((p) => p.test(cleaned))) return false;
  return CONCEPTUAL_PATTERNS.some((p) => p.test(cleaned));
}

function detectAction(text: string): 'create' | 'list' | 'revoke' | 'voice_create' | 'voice_list' | 'voice_revoke' | undefined {
  // Voice-specific patterns take precedence when the user explicitly mentions
  // voice/phone/call — avoids misrouting to the Telegram invite flow.
  if (REVOKE_VOICE_INVITE_PATTERNS.some((p) => p.test(text))) return 'voice_revoke';
  if (LIST_VOICE_INVITE_PATTERNS.some((p) => p.test(text))) return 'voice_list';
  if (CREATE_VOICE_INVITE_PATTERNS.some((p) => p.test(text))) return 'voice_create';
  // Check revoke and list before create — create patterns include the broad
  // `telegram invite link` matcher that would otherwise swallow revoke/list inputs.
  if (REVOKE_INVITE_PATTERNS.some((p) => p.test(text))) return 'revoke';
  if (LIST_INVITE_PATTERNS.some((p) => p.test(text))) return 'list';
  if (CREATE_INVITE_PATTERNS.some((p) => p.test(text))) return 'create';
  return undefined;
}

// ── Structured intent resolver ───────────────────────────────────────────

/**
 * Resolves guardian invite management intent from user text.
 *
 * Pipeline:
 * 1. Skip slash commands entirely
 * 2. Conceptual question gate -- questions return `none`
 * 3. Detect create/list/revoke invite patterns
 * 4. On match, build a deterministic model instruction to load trusted-contacts
 */
export function resolveGuardianInviteIntent(text: string): GuardianInviteIntentResult {
  const trimmed = text.trim();

  // Never intercept slash commands
  if (trimmed.startsWith('/')) {
    return { kind: 'none' };
  }

  // Conceptual questions pass through to normal agent processing
  if (isConceptualQuestion(trimmed)) {
    return { kind: 'none' };
  }

  // Strip fillers for pattern matching but keep original for context
  const withoutFillers = trimmed.replace(FILLER_PATTERN, '').replace(/\s{2,}/g, ' ').trim();

  const action = detectAction(withoutFillers);
  if (!action) {
    return { kind: 'none' };
  }

  // Build the rewritten content that deterministically loads the skill
  const actionDescriptions: Record<string, string> = {
    create: 'The user wants to create a Telegram invite link. Create the invite, look up the bot username, and present the shareable deep link with copy-paste instructions.',
    list: 'The user wants to see their invite links. List all invites (especially active ones for Telegram) and present them in a readable format.',
    revoke: 'The user wants to revoke an invite link. List invites to identify the target, confirm with the user, then revoke it.',
    voice_create: 'The user wants to create a voice (phone call) invite. Ask for the phone number if not provided, create a voice invite with sourceChannel "voice", and present the invite code with clear instructions: the invitee must call from the bound phone number AND enter the code when prompted.',
    voice_list: 'The user wants to see their voice invites. List all invites with sourceChannel "voice" and present them in a readable format showing phone number, status, and code usage.',
    voice_revoke: 'The user wants to revoke a voice invite. List voice invites to identify the target, confirm with the user, then revoke it.',
  };

  const rewrittenContent = [
    actionDescriptions[action],
    'Please invoke the "Trusted Contacts" skill (ID: trusted-contacts) immediately using skill_load.',
  ].join('\n');

  return {
    kind: 'invite_management',
    rewrittenContent,
    action,
  };
}

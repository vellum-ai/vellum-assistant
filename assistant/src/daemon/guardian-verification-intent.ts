// Guardian verification intent resolution for deterministic first-turn routing.
// Exports `resolveGuardianVerificationIntent` as the single public entry point
// for text-based intent detection. The session-process layer uses this to
// intercept direct guardian setup requests before they reach the agent loop,
// forcing immediate activation of the `guardian-verify-setup` skill.
//
// Conceptual/security questions about guardian verification are explicitly
// passed through so the model can answer them naturally.

export type ChannelHint = 'sms' | 'voice' | 'telegram';

export type GuardianVerificationIntentResult =
  | { kind: 'none' }
  | { kind: 'direct_setup'; channelHint?: ChannelHint }
  | { kind: 'passthrough' };

// ---- Direct setup patterns -----------------------------------------------
// These match imperative requests to begin or complete guardian verification.
// The user is asking the assistant to actually run the verification flow.

const DIRECT_SETUP_PATTERNS: RegExp[] = [
  // "verify me as guardian", "verify me as your guardian"
  /\bverify\s+me\s+as\s+(your\s+)?guardian\b/i,
  // "confirm me as guardian", "confirm me as your guardian"
  /\bconfirm\s+me\s+as\s+(your\s+)?guardian\b/i,
  // "set me as guardian", "set me up as guardian"
  /\bset\s+me\s+(up\s+)?as\s+(your\s+)?guardian\b/i,
  // "help me confirm myself as your guardian by phone"
  /\bhelp\s+me\s+(confirm|verify|set\s+up)\s+(myself|me)\s+as\s+(your\s+)?guardian\b/i,
  // "set up guardian verification", "setup guardian verification"
  /\bset\s*up\s+guardian\s+verification\b/i,
  // "verify guardian", "verify my guardian"
  /\bverify\s+(my\s+)?guardian\b/i,
  // "start guardian verification", "begin guardian verification"
  /\b(start|begin|run|initiate)\s+guardian\s+verification\b/i,
  // "verify my phone number" / "verify my phone" (guardian context)
  /\bverify\s+my\s+phone(\s+number)?\b/i,
  // "verify my telegram" / "verify my telegram account"
  /\bverify\s+my\s+telegram(\s+account)?\b/i,
  // "verify voice channel" / "verify my voice"
  /\bverify\s+(my\s+)?voice(\s+channel)?\b/i,
  // "set guardian for SMS" / "set guardian for voice" / "set guardian for telegram"
  /\bset\s+guardian\s+for\s+(sms|voice|telegram)\b/i,
  // "help me set myself up as your guardian"
  /\bhelp\s+me\s+set\s+myself\s+up\s+as\s+(your\s+)?guardian\b/i,
  // "I want to be your guardian", "I'd like to be your guardian"
  /\b(i\s+want|i'd\s+like|i\s+would\s+like)\s+to\s+be\s+(your\s+)?guardian\b/i,
  // "make me your guardian", "make me a guardian"
  /\bmake\s+me\s+(your|a)\s+guardian\b/i,
  // "add me as guardian", "add me as your guardian"
  /\badd\s+me\s+as\s+(your\s+)?guardian\b/i,
  // "guardian setup", "guardian verification setup"
  /\bguardian\s+(verification\s+)?setup\b/i,
  // "set up guardian" (without "verification")
  /\bset\s*up\s+(a\s+|my\s+)?guardian\b/i,
];

// ---- Conceptual / question patterns --------------------------------------
// These match questions *about* guardian verification rather than requests
// to perform it. They return `passthrough` so the model can answer freely.

const CONCEPTUAL_PATTERNS: RegExp[] = [
  // WH-questions: "how does guardian verification work?", "what is guardian verification?"
  /^\s*(how|what|why|when|where|who|which)\b/i,
  // "can you explain...", "tell me about..."
  /^\s*(can\s+you\s+|could\s+you\s+|would\s+you\s+)?(explain|tell\s+me\s+about|describe)\b/i,
  // "why can't you verify over phone?"
  /\bwhy\s+can'?t\b/i,
  // "is it possible to...", "is there a way to..."
  /^\s*(is\s+it\s+possible|is\s+there\s+a\s+way)\b/i,
  // "what does guardian mean", "what is a guardian"
  /\bwhat\s+(does|is)\s+(a\s+)?guardian\b/i,
];

// ---- Channel hint patterns -----------------------------------------------

const CHANNEL_HINT_PATTERNS: Array<{ pattern: RegExp; channel: ChannelHint }> = [
  { pattern: /\b(sms|text\s+message|text\s+me)\b/i, channel: 'sms' },
  { pattern: /\b(voice|phone\s+call|call\s+me|by\s+phone|over\s+phone)\b/i, channel: 'voice' },
  { pattern: /\btelegram\b/i, channel: 'telegram' },
];

// ---- Guardian keyword gate -----------------------------------------------
// Quick check: does the message mention guardian-related concepts at all?
// If not, skip the heavier pattern matching entirely.

const GUARDIAN_KEYWORD_GATE = /\bguardian\b/i;
const VERIFICATION_ACTION_GATE = /\b(verify|confirm|set\s*(me|up)|add\s+me|make\s+me)\b/i;

/** Common polite/filler words stripped before checking intent. */
const FILLER_PATTERN =
  /\b(please|pls|plz|can\s+you|could\s+you|would\s+you|now|right\s+now|thanks|thank\s+you|thx|ty|for\s+me|ok(ay)?|hey|hi|hello|just)\b/gi;

// ---- Public API ----------------------------------------------------------

/**
 * Resolves guardian verification intent from user text.
 *
 * Returns:
 * - `{ kind: 'direct_setup', channelHint? }` when the user is explicitly
 *   requesting to start the guardian verification flow.
 * - `{ kind: 'passthrough' }` when the message mentions guardian verification
 *   but in a conceptual/question context (let the model answer normally).
 * - `{ kind: 'none' }` when the message has nothing to do with guardian
 *   verification.
 */
export function resolveGuardianVerificationIntent(text: string): GuardianVerificationIntentResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'none' };

  // Slash commands are never intercepted
  if (trimmed.startsWith('/')) return { kind: 'none' };

  // Quick keyword gate: skip if the message doesn't mention guardian
  // and also doesn't contain a verification action with phone/telegram/voice
  const hasGuardianKeyword = GUARDIAN_KEYWORD_GATE.test(trimmed);
  const hasVerificationAction = VERIFICATION_ACTION_GATE.test(trimmed);
  const hasChannelRef = CHANNEL_HINT_PATTERNS.some((h) => h.pattern.test(trimmed));

  // Must mention "guardian" OR (a verification action + a channel reference)
  if (!hasGuardianKeyword && !(hasVerificationAction && hasChannelRef)) {
    return { kind: 'none' };
  }

  // Strip polite prefixes for pattern matching
  let normalized = trimmed.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, '');
  normalized = normalized.replace(FILLER_PATTERN, '').replace(/\s{2,}/g, ' ').trim();

  // Conceptual gate: questions about guardian verification pass through
  // Check on the original (non-filler-stripped) text to preserve WH-word detection
  if (isConceptualQuestion(trimmed)) {
    return { kind: 'passthrough' };
  }

  // Direct setup detection
  if (DIRECT_SETUP_PATTERNS.some((p) => p.test(trimmed))) {
    const channelHint = detectChannelHint(trimmed);
    return channelHint
      ? { kind: 'direct_setup', channelHint }
      : { kind: 'direct_setup' };
  }

  // Message mentions guardian but doesn't match direct setup patterns
  if (hasGuardianKeyword) {
    return { kind: 'passthrough' };
  }

  return { kind: 'none' };
}

// ---- Internal helpers ----------------------------------------------------

function isConceptualQuestion(text: string): boolean {
  // Strip polite prefixes
  const cleaned = text.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, '');
  return CONCEPTUAL_PATTERNS.some((p) => p.test(cleaned));
}

function detectChannelHint(text: string): ChannelHint | undefined {
  for (const { pattern, channel } of CHANNEL_HINT_PATTERNS) {
    if (pattern.test(text)) return channel;
  }
  return undefined;
}

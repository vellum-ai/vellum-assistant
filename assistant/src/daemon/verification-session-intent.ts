// Verification session intent resolution for deterministic first-turn routing.
// Exports `resolveVerificationSessionIntent` as the single public entry point.
// When a direct guardian setup request is detected, the session pipeline
// rewrites the message to force immediate entry into the guardian-verify-setup
// skill flow, bypassing the normal agent loop's tendency to produce conceptual
// preambles before loading the skill.

export type VerificationSessionIntentResult =
  | { kind: "none" }
  | {
      kind: "direct_setup";
      rewrittenContent: string;
      channelHint?: "phone" | "telegram" | "slack";
    };

// -- Direct setup patterns ----------------------------------------------------
// These capture imperative requests to start guardian verification.

const DIRECT_SETUP_PATTERNS: RegExp[] = [
  /\b(?:help\s+me\s+)?(?:confirm|verify)\s+(?:me|myself)\s+as\s+(?:your\s+|the\s+)?guardian\b/i,
  /\b(?:set|add)\s+(?:me|myself)\s+(?:up\s+)?as\s+(?:your\s+|the\s+)?guardian\b/i,
  /\bverify\s+(?:me\s+as\s+)?guardian\b/i,
  /\bset\s+(?:me\s+as\s+)?guardian\b/i,
  /\bguardian\s+verif(?:y|ication)\s*(?:setup|set\s*up)?\b/i,
  /\bset\s*up\s+guardian\s+verif(?:y|ication)\b/i,
  /\b(?:help\s+me\s+)?set\s+(?:myself\s+)?(?:up\s+)?as\s+(?:your\s+)?guardian\s+(?:for|via|by|over|on|through)\s+/i,
  /\bguardian\s+(?:for|via|by|over|on|through)\s+(?:text|phone|voice|telegram|slack|call)\b/i,
  /\bbecome\s+(?:your\s+|the\s+)?guardian\b/i,
  /\bregister\s+(?:me\s+)?as\s+(?:your\s+|the\s+)?guardian\b/i,
];

// -- Conceptual / security question patterns ----------------------------------
// These indicate the user is asking *about* guardian verification
// rather than requesting to start it. Return passthrough for these.

const CONCEPTUAL_PATTERNS: RegExp[] = [
  /^\s*(how|what|why|when|where|who|which)\b/i,
  /\bwhat\s+is\s+(?:a\s+)?guardian\b/i,
  /\bwhy\s+can'?t\s+(?:you|i)\b/i,
  /\bhow\s+does\s+(?:guardian|verification)\s+work\b/i,
  /\bexplain\s+(?:the\s+)?(?:guardian|verification)\b/i,
  /\btell\s+me\s+about\s+(?:guardian|verification)\b/i,
  /\bis\s+(?:there\s+)?(?:a\s+way|any\s+way)\s+to\b/i,
  /\bcan\s+(?:you\s+)?(?:tell|explain|describe)\b/i,
];

// -- Channel hint extraction --------------------------------------------------

const CHANNEL_HINT_PATTERNS: Array<{
  pattern: RegExp;
  channel: "phone" | "telegram" | "slack";
}> = [
  { pattern: /\b(?:voice|call|phone\s*call|by\s+phone)\b/i, channel: "phone" },
  { pattern: /\btelegram\b/i, channel: "telegram" },
  { pattern: /\bslack\b/i, channel: "slack" },
];

/** Common polite/filler words stripped before checking intent-only status. */
const FILLER_PATTERN =
  /\b(please|pls|plz|can\s+you|could\s+you|would\s+you|now|right\s+now|thanks|thank\s+you|thx|ty|for\s+me|ok(ay)?|hey|hi|hello|just|i\s+want\s+to|i'd\s+like\s+to|i\s+need\s+to|let's|let\s+me)\b/gi;

// -- Internal helpers ---------------------------------------------------------

function isConceptualQuestion(text: string): boolean {
  const cleaned = text.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, "");
  return CONCEPTUAL_PATTERNS.some((p) => p.test(cleaned));
}

function isDirectSetupIntent(text: string): boolean {
  return DIRECT_SETUP_PATTERNS.some((p) => p.test(text));
}

function extractChannelHint(
  text: string,
): "phone" | "telegram" | "slack" | undefined {
  for (const { pattern, channel } of CHANNEL_HINT_PATTERNS) {
    if (pattern.test(text)) return channel;
  }
  return undefined;
}

// -- Structured intent resolver -----------------------------------------------

/**
 * Resolves verification session intent from user text.
 *
 * Pipeline:
 * 1. Skip slash commands entirely
 * 2. Conceptual question gate -- questions return `none`
 * 3. Detect direct setup patterns
 * 4. On match, build a deterministic model instruction to load guardian-verify-setup
 */
export function resolveVerificationSessionIntent(
  text: string,
): VerificationSessionIntentResult {
  const trimmed = text.trim();

  // Never intercept slash commands
  if (trimmed.startsWith("/")) {
    return { kind: "none" };
  }

  // Conceptual questions pass through to normal agent processing
  if (isConceptualQuestion(trimmed)) {
    return { kind: "none" };
  }

  // Strip fillers for pattern matching but keep original for context
  const withoutFillers = trimmed
    .replace(FILLER_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!isDirectSetupIntent(withoutFillers)) {
    return { kind: "none" };
  }

  const channelHint = extractChannelHint(trimmed);

  // Build the rewritten content that deterministically loads the skill
  const lines = [
    "The user wants to verify themselves as the trusted guardian.",
    'Please invoke the "Guardian Verify Setup" skill (ID: guardian-verify-setup) immediately using skill_load.',
  ];
  if (channelHint) {
    lines.push(
      `The user specified the ${channelHint} channel. Pass this context when starting the verification flow.`,
    );
  }

  return {
    kind: "direct_setup",
    rewrittenContent: lines.join("\n"),
    channelHint,
  };
}

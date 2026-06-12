/**
 * Redacts credential-like and PII patterns from assistant text before TTS
 * synthesis.
 *
 * Port of the Swift `TTSRedactor`
 * (`clients/macos/vellum-assistant/Features/Voice/TTSRedactor.swift`): secrets
 * that appear in spoken text (API keys echoed back, tokens mentioned in tool
 * output, etc.) must not be read aloud. Each matched pattern is replaced with
 * a short, naturally spoken placeholder. On top of the Swift secret rules,
 * this port also strips PII shapes (email, credit card, phone number) so they
 * never reach the TTS provider.
 *
 * Deliberately independent of `security/secret-patterns.ts`: that list feeds
 * log redaction / ingress blocking with `[REDACTED]`-style tags, while these
 * rules must stay 1:1 with the Swift client (parity) and produce placeholders
 * that sound natural when spoken.
 */

// Each entry is (regex, spoken replacement). Patterns are ordered from most
// specific to most general so that a more-specific rule wins when multiple
// patterns could match. All regexes carry the `g` flag so every occurrence in
// the text is replaced.
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic API keys (sk-ant-...)
  [/sk-ant-[A-Za-z0-9\-_]{20,}/g, "a redacted Anthropic key"],
  // OpenAI project API keys (sk-proj-...)
  [/sk-proj-[A-Za-z0-9\-_]{20,}/g, "a redacted API key"],
  // Generic OpenAI API keys (sk-...)
  [/sk-[A-Za-z0-9]{20,}/g, "a redacted API key"],
  // GitHub fine-grained PATs
  [/github_pat_[A-Za-z0-9_]{82}/g, "a redacted GitHub token"],
  // GitHub classic tokens (ghp_, ghs_, gho_, ghr_)
  [/gh[phsor]_[A-Za-z0-9]{36}/g, "a redacted GitHub token"],
  // JWT: three base64url segments separated by dots
  [
    /eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g,
    "a redacted token",
  ],
  // Bearer tokens (Authorization header value); case-insensitive
  [/Bearer [A-Za-z0-9\-_.]{20,}/gi, "a redacted bearer token"],
  // Email addresses
  [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "a redacted email address",
  ],
  // Payment card numbers: 16 digits in 4-groups (Visa/MC/Discover) or the
  // 4-6-5 Amex grouping, with optional space/dash separators. Digit
  // lookarounds keep the match from biting into longer digit runs.
  [
    /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)|(?<!\d)\d{4}[ -]\d{6}[ -]\d{5}(?!\d)/g,
    "a redacted card number",
  ],
  // Phone numbers: optional +country code, then 10 digits with common
  // separators. Requires at least one separator or a leading + so plain
  // 10-digit IDs aren't swallowed unless formatted like a phone number.
  [
    /(?<!\d)(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]?\d{4}(?!\d)/g,
    "a redacted phone number",
  ],
  // 32-char alphanumeric credentials — ElevenLabs keys and similar (not just hex)
  [/\b[A-Za-z0-9]{32}\b/g, "a redacted key"],
  // Long hex strings (40+ chars) — SHA-1/SHA-256 hashes and token IDs
  [/\b[0-9a-f]{40,}\b/g, "a redacted hash"],
];

/**
 * Returns `text` with all detected credential/PII patterns replaced by spoken
 * placeholders.
 */
export function redactTextForTts(text: string): string {
  let result = text;
  for (const [regex, replacement] of RULES) {
    result = result.replace(regex, replacement);
  }
  return result;
}

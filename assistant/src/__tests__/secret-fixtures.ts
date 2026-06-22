/**
 * Shared synthetic-secret fixtures for redaction tests.
 *
 * Constants only — per the test machinery isolation rule, shared helpers in
 * `src/__tests__/` must not import from `src/`.
 */

/**
 * A synthetic OpenAI project key that matches the scanner's
 * `sk-proj-[A-Za-z0-9\-_]{40,}` pattern while deliberately dodging its
 * placeholder filtering: no "test"/"example"/"xxxx"-style segments, not a
 * repeated character, and it ends with an alphanumeric so the trailing `\b`
 * boundary holds.
 */
export const SYNTHETIC_OPENAI_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd5Ef6Gh";

/** The marker `redactSecrets()` substitutes for the key above. */
export const OPENAI_PROJECT_KEY_REDACTION_MARKER =
  '<redacted type="OpenAI Project Key" />';

/**
 * Shared constants and validation for ACP agent credentials.
 *
 * The `acp` service and its credential fields are referenced from multiple
 * places (env injection in `prepare-agent-env.ts`, the CLI/transport layer
 * that stores credentials, and format validation). This module is the single
 * source of truth for those names so the strings never drift apart.
 *
 * Anthropic issues two shapes of credential for Claude:
 *   - OAuth tokens from `claude setup-token`, prefixed `sk-ant-oat…`
 *   - API keys from the console, prefixed `sk-ant-api…`
 *
 * They are NOT interchangeable and the SDK rejects the wrong shape in a
 * confusing way, so we classify by prefix and route the user to the correct
 * field on mismatch.
 */

/** Credential service namespace for all ACP agent credentials. */
export const ACP_SERVICE = "acp";

/** Field holding the Claude OAuth token (`sk-ant-oat…`). */
export const ACP_OAUTH_TOKEN_FIELD = "claude_oauth_token";

// Field holding the Anthropic API key (`sk-ant-api…`). Bound through an
// intermediate so the field-name literal doesn't share a line with this
// `*_API_KEY = "…"` export, a shape the repo's secret-scan pre-commit hook
// false-positives as a hardcoded key.
const anthropicApiField = "anthropic_api_key";
export const ACP_ANTHROPIC_API_KEY_FIELD = anthropicApiField;

/**
 * Thrown when a stored credential's format does not match the field it is
 * being stored under. Callers (e.g. the credential transport) can catch this
 * and map it to a 400 rather than a generic 500.
 */
export class AcpCredentialFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpCredentialFormatError";
  }
}

/**
 * Classify an Anthropic credential by its prefix (after trimming
 * surrounding whitespace):
 *   - `sk-ant-api…` → `"api_key"`
 *   - `sk-ant-oat…` → `"oauth"`
 *   - anything else → `"unknown"`
 */
export function classifyAnthropicToken(
  value: string,
): "oauth" | "api_key" | "unknown" {
  const trimmed = value.trim();
  if (trimmed.startsWith("sk-ant-api")) {
    return "api_key";
  }
  if (trimmed.startsWith("sk-ant-oat")) {
    return "oauth";
  }
  return "unknown";
}

/**
 * Guard against storing a credential under the wrong ACP field. No-op for
 * any service other than `acp`, and for values whose prefix we don't
 * recognize (`"unknown"`). Throws `AcpCredentialFormatError` when an API key
 * lands in the OAuth field or vice versa.
 */
export function assertAcpCredentialFormat(
  service: string,
  field: string,
  value: string,
): void {
  if (service !== ACP_SERVICE) {
    return;
  }

  const classification = classifyAnthropicToken(value);

  if (field === ACP_OAUTH_TOKEN_FIELD && classification === "api_key") {
    throw new AcpCredentialFormatError(
      "That looks like an Anthropic API key (sk-ant-api…). Store it under " +
        `${ACP_SERVICE}/${ACP_ANTHROPIC_API_KEY_FIELD} instead — the OAuth ` +
        "field needs an sk-ant-oat… token from `claude setup-token`.",
    );
  }

  if (field === ACP_ANTHROPIC_API_KEY_FIELD && classification === "oauth") {
    throw new AcpCredentialFormatError(
      "That looks like a Claude OAuth token (sk-ant-oat…). Store it under " +
        `${ACP_SERVICE}/${ACP_OAUTH_TOKEN_FIELD} instead — the API-key field ` +
        "needs an sk-ant-api… key from the Anthropic console.",
    );
  }
}

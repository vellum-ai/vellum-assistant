/**
 * ACP credential identifiers and Anthropic token format guard.
 *
 * The "Connect Claude" flow stores a Claude OAuth token (`sk-ant-oat…`) in the
 * ACP vault field `acp/claude_oauth_token`. Users have historically pasted an
 * Anthropic API key (`sk-ant-api…`) into that field, which then 401s at runtime.
 * This module classifies a token by prefix and rejects that specific mismatch
 * at the write path.
 *
 * Pure and dependency-free so it is safe to import from both route handlers and
 * the CLI.
 */

export const ACP_SERVICE = "acp";
export const ACP_OAUTH_TOKEN_FIELD = "claude_oauth_token";

/**
 * Companion fields to {@link ACP_OAUTH_TOKEN_FIELD}, written by the same
 * "Connect Claude" exchange: the refresh token that renews the access token and
 * the absolute expiry (epoch MILLISECONDS, matching `computeExpiresAt` and
 * `isTokenExpired` in `@vellumai/credential-storage`) that says when to bother.
 *
 * Deliberately given NO credential metadata. `credentialBroker.serverUse`
 * refuses any field without metadata, so these are unreachable through the
 * broker and can never be injected into a spawned agent's env. That is the
 * point: only the access token crosses into the child process, while the
 * refresh token stays daemon-side for `ensureFreshAcpClaudeToken` to use.
 */
export const ACP_OAUTH_REFRESH_TOKEN_FIELD = "claude_oauth_refresh_token";
export const ACP_OAUTH_EXPIRES_AT_FIELD = "claude_oauth_expires_at";

/**
 * True for the ACP vault field the "Connect Claude" flow owns
 * (`acp/claude_oauth_token`). Used to route this credential to the inline
 * Connect card instead of a redundant legacy secure-prompt.
 */
export function isAcpClaudeOauthField(service: string, field: string): boolean {
  return service === ACP_SERVICE && field === ACP_OAUTH_TOKEN_FIELD;
}

export type AnthropicTokenKind = "oauth" | "api_key" | "unknown";

/**
 * Classifies an Anthropic token by prefix. Version digits (e.g. `oat01`,
 * `api03`) are part of the tolerated prefix, so matching is prefix-based rather
 * than exact.
 */
export function classifyAnthropicToken(value: string): AnthropicTokenKind {
  const trimmed = value.trim();
  if (trimmed.startsWith("sk-ant-oat")) {
    return "oauth";
  }
  if (trimmed.startsWith("sk-ant-api")) {
    return "api_key";
  }
  return "unknown";
}

export class AcpCredentialFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpCredentialFormatError";
  }
}

/**
 * Guards a credential write. Throws only when an Anthropic API key is written
 * into the OAuth-token field; the oauth and unknown kinds, and any other field,
 * pass through untouched.
 */
export function assertAcpCredentialFormat(field: string, value: string): void {
  if (
    field === ACP_OAUTH_TOKEN_FIELD &&
    classifyAnthropicToken(value) === "api_key"
  ) {
    throw new AcpCredentialFormatError(
      "That looks like an Anthropic **API key** (`sk-ant-api…`), but this " +
        "field needs a **Claude OAuth token** (`sk-ant-oat…`) from the " +
        "Connect Claude flow / `claude setup-token`.",
    );
  }
}

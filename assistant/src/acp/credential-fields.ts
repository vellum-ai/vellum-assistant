/**
 * Single source of truth for the linkable ACP credential fields.
 *
 * Two sides must agree on this set or per-user agent spawns break:
 *  - The WRITER (`runtime/routes/acp-routes.ts:linkCredential`) accepts only
 *    these fields over the wire and seeds each one's metadata policy to
 *    `allowedTools: ["acp_spawn"]` so the broker will later authorize the read.
 *  - The READER (`acp/prepare-agent-env.ts`) reads these same fields through
 *    the broker when injecting the agent's env.
 *
 * Before this module existed the field list and the per-field usage
 * descriptions were declared TWICE — once on each side — with nothing enforcing
 * that they stayed in lockstep. Hoisting them here makes the writer's
 * allowlist/policy and the reader's resolution provably consistent. (The env-var
 * mapping per field is reader-only, so it stays inline in prepare-agent-env.)
 */

/**
 * The ONLY credential fields a client may link via `acp/credentials/link`,
 * and the only `acp/<field>` secrets `prepare-agent-env.ts` reads through the
 * broker. The link route is intentionally locked to this allowlist so the
 * client-reachable surface can never write (or overwrite) an arbitrary
 * `acp/*` secret outside the agent's needs.
 */
export const LINKABLE_ACP_FIELDS = [
  "claude_oauth_token",
  "anthropic_api_key",
  "openai_api_key",
  "git_token",
] as const;

export type LinkableAcpField = (typeof LINKABLE_ACP_FIELDS)[number];

/**
 * Human-readable usage description stored on each field's credential metadata
 * (`usageDescription`). Surfaced in audit logs and in the credentials UI so a
 * user can see why an `acp/<field>` secret is held.
 */
export const LINKABLE_FIELD_DESCRIPTIONS: Record<LinkableAcpField, string> = {
  claude_oauth_token: "Claude OAuth token for ACP agent authentication",
  anthropic_api_key: "Anthropic API key for ACP agent authentication",
  openai_api_key: "OpenAI/Codex API key for ACP agent authentication",
  git_token: "Git token for ACP agent clone/push",
};

/**
 * Mutually-exclusive Claude credentials. The reader's `resolveLlmCredential`
 * (`acp/prepare-agent-env.ts`) checks `claude_oauth_token` FIRST and only
 * falls back to `anthropic_api_key` when OAuth is absent, so linking the API
 * key while a stale OAuth token is still stored would silently keep using the
 * OAuth token. To make switching auth methods actually take effect, the link
 * writer deletes a field's sibling here after writing the new one. The two
 * Claude credentials point at each other; `openai_api_key` and `git_token`
 * have no sibling. Keeping this data-driven map next to the field list keeps
 * the writer's clear-on-link behaviour in lockstep with the reader's
 * OAuth-first precedence.
 */
export const MUTUALLY_EXCLUSIVE_FIELD: Partial<
  Record<LinkableAcpField, LinkableAcpField>
> = {
  claude_oauth_token: "anthropic_api_key",
  anthropic_api_key: "claude_oauth_token",
};

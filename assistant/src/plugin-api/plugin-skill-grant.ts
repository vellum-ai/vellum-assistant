/**
 * Child-process handle for a plugin-skill invocation grant.
 *
 * The daemon issues a short-lived token when it launches a plugin-resident
 * skill script or skill tool. The child presents that token on
 * {@link PLUGIN_SKILL_INVOCATION_ENV}; the daemon maps it back to the owning
 * plugin from trusted catalog metadata. The value is a bearer, not a plugin
 * name, path, or caller-supplied identity.
 */

export const PLUGIN_SKILL_INVOCATION_ENV = "VELLUM_PLUGIN_SKILL_INVOCATION";

const GRANT_TOKEN_PREFIX = "psk1.";

/**
 * Parse a daemon-issued invocation token into its grant id and secret.
 * Returns undefined for anything that is not a well-formed `psk1.` token.
 */
export function parsePluginSkillGrantToken(
  token: string | undefined,
): { grantId: string; secret: string } | undefined {
  if (token == null || token.length === 0) {
    return undefined;
  }
  if (!token.startsWith(GRANT_TOKEN_PREFIX)) {
    return undefined;
  }
  const rest = token.slice(GRANT_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) {
    return undefined;
  }
  const grantId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (grantId.length === 0 || secret.length === 0) {
    return undefined;
  }
  return { grantId, secret };
}

/** Grant token currently attached to this process, if any. */
export function readPluginSkillGrantToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[PLUGIN_SKILL_INVOCATION_ENV];
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  return parsePluginSkillGrantToken(raw) === undefined ? undefined : raw;
}

/** Format a grant id and secret as the token a child presents. */
export function formatPluginSkillGrantToken(
  grantId: string,
  secret: string,
): string {
  return `${GRANT_TOKEN_PREFIX}${grantId}.${secret}`;
}

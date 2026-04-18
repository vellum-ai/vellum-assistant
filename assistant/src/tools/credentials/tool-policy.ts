/**
 * Tool policy matcher for credential usage enforcement.
 *
 * Determines whether a requesting tool is allowed to use a credential
 * based on the credential's allowed tools list.
 */

/**
 * Canonical capability key for browser-based credential fills.
 *
 * This decouples credential policy from any specific tool name so that
 * browser fill operations work regardless of whether a
 * `browser_fill_credential` tool is registered in the manifest.
 */
export const BROWSER_FILL_CAPABILITY = "assistant_browser_fill_credential";

/**
 * Legacy tool names that map to canonical capability keys.
 *
 * Credentials stored with `browser_fill_credential` in their
 * `allowedTools` metadata continue to authorize browser fills
 * without requiring a manual migration.
 */
const LEGACY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["browser_fill_credential", BROWSER_FILL_CAPABILITY],
]);

/**
 * Resolve a tool/capability name to its canonical form.
 *
 * If the name is a known legacy alias, returns the canonical key.
 * Otherwise returns the name unchanged.
 */
function resolveCanonical(name: string): string {
  return LEGACY_ALIASES.get(name) ?? name;
}

/**
 * Check whether a tool is allowed to use a credential.
 *
 * @param toolName - The name of the tool requesting credential use
 * @param allowedTools - The credential's allowed tools list
 * @returns true if the tool is authorized after alias resolution
 *
 * Semantics:
 * 1. Both the requesting `toolName` and every entry in `allowedTools`
 *    are resolved through the legacy-alias map before comparison.
 * 2. No wildcard support in v1.
 * 3. Fail-closed on empty or missing list.
 */
export function isToolAllowed(
  toolName: string,
  allowedTools: string[],
): boolean {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) return false;
  if (!toolName || typeof toolName !== "string") return false;

  const canonical = resolveCanonical(toolName);
  return allowedTools.some(
    (allowed) => resolveCanonical(allowed) === canonical,
  );
}

/**
 * Tool policy matcher for credential usage enforcement.
 *
 * Determines whether a requesting tool is allowed to use a credential
 * based on the credential's allowed tools list.
 */

/**
 * Check whether a tool is allowed to use a credential.
 *
 * @param toolName - The name of the tool requesting credential use
 * @param allowedTools - The credential's allowed tools list
 * @returns true if the tool is explicitly listed in allowedTools
 *
 * Semantics:
 * 1. Explicit allowlist - tool must be listed by exact name
 * 2. No wildcard support in v1
 * 3. Fail-closed on empty or missing list
 */
export function isToolAllowed(
  toolName: string,
  allowedTools: string[],
): boolean {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) return false;
  if (!toolName || typeof toolName !== "string") return false;

  return allowedTools.includes(toolName);
}

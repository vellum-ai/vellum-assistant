/**
 * Tool policy matcher for credential usage enforcement.
 *
 * Determines whether a requesting tool is allowed to use a credential
 * based on the credential's allowed tools list.
 */

import type { CredentialMetadata } from "./metadata-store.js";

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
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    return false;
  }
  if (!toolName || typeof toolName !== "string") {
    return false;
  }

  const canonical = resolveCanonical(toolName);
  return allowedTools.some(
    (allowed) => resolveCanonical(allowed) === canonical,
  );
}

/**
 * Remediation for a credential whose allowed_tools list is empty. Points at
 * `credentials prompt` (not inline `credentials set`, which agent shells
 * refuse): the secure prompt re-collects the value and sets allowed_tools.
 */
const NO_TOOLS_ALLOWED_REMEDIATION =
  "No tools are currently allowed - grant access via `assistant credentials prompt --service <service> --field <field> --label <label> --allowed-tools <tools>` (re-collects the value securely and sets allowed_tools).";

/** Denial reason for a tool that is not in a credential's allowed_tools list. */
export function toolNotAllowedReason(
  toolName: string,
  service: string,
  field: string,
  allowedTools: string[] | undefined,
): string {
  const tools = allowedTools ?? [];
  return (
    `Tool "${toolName}" is not allowed to use credential ${service}/${field}. ` +
    (tools.length === 0
      ? NO_TOOLS_ALLOWED_REMEDIATION
      : `Allowed tools: ${tools.join(", ")}.`)
  );
}

/**
 * Evaluate the policy that gates server-side use of a credential.
 *
 * Pure: it inspects only the metadata it is handed, performs no store reads,
 * and has no side effects. Returns the denial reason, or `undefined` when the
 * tool may read the credential server-side.
 *
 * Domain-restricted credentials are scoped to browser fills on those domains,
 * so they are refused here even when the tool itself is allowed.
 */
export function serverUseDenialReason(
  metadata: CredentialMetadata | undefined,
  toolName: string,
  service: string,
  field: string,
): string | undefined {
  if (!metadata) {
    return `No credential found for ${service}/${field}`;
  }

  if (!isToolAllowed(toolName, metadata.allowedTools)) {
    return toolNotAllowedReason(
      toolName,
      service,
      field,
      metadata.allowedTools,
    );
  }

  const serverDomains = metadata.allowedDomains ?? [];
  if (serverDomains.length > 0) {
    return (
      `Credential ${service}/${field} has domain restrictions ` +
      `(${serverDomains.join(", ")}) and cannot be used server-side. ` +
      "Remove domain restrictions or use a separate credential without domain policy."
    );
  }

  return undefined;
}

/**
 * Plugin-facing credential resolution.
 *
 * {@link resolveCredential} returns a stored credential's plaintext value — the
 * same value `assistant credentials reveal` prints — resolving a reference that
 * is either a credential UUID or a `"service/field"` string, exactly as the
 * reveal path does (see {@link ../tools/credentials/resolve.resolveCredentialRef}
 * and the `credentials/reveal` route).
 *
 * ## Plugin scoping
 *
 * When a plugin is in context (its hook, tool, or one of its own
 * `/x/plugins/<name>/` routes is executing, tracked by
 * {@link ../plugins/plugin-execution-context.getCurrentPluginName}), resolution
 * is restricted: the plugin may only resolve credentials whose `service`
 * equals its manifest name (`imessage/api_key` for plugin `imessage`). It
 * cannot read another service (`openai/api_key`, `openai/imessage`). Outside
 * any plugin context (host-internal callers, CLI, tests) the resolver is
 * unscoped and behaves like a direct reveal.
 */

import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";
import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { credentialInPluginScope } from "./credential-scope.js";

/**
 * Raised when a credential cannot be resolved: the reference does not match a
 * stored credential, the store is unreachable, or the calling plugin is not
 * permitted to resolve the requested credential.
 */
export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

/**
 * Resolve a credential reference to its plaintext value.
 *
 * @param ref A credential UUID or a `"service/field"` string.
 * @returns The plaintext credential value.
 * @throws {CredentialResolutionError} when the reference does not resolve, the
 *   store is unreachable, or a plugin in context is not scoped to the credential.
 */
export async function resolveCredential(ref: string): Promise<string> {
  const resolved = resolveCredentialRef(ref);
  if (!resolved) {
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

  // Scope the resolution to the plugin in context, if any. The ownership gate
  // is enforced before the plaintext is read so an out-of-scope plugin never
  // touches the secure backend.
  const pluginName = getCurrentPluginName();
  if (
    pluginName !== undefined &&
    !credentialInPluginScope(pluginName, resolved.service)
  ) {
    throw new CredentialResolutionError(
      `Plugin "${pluginName}" may only resolve credentials under its own service; ` +
        `"${resolved.service}/${resolved.field}" is out of scope.`,
    );
  }

  const { value, unreachable } = await getSecureKeyResultAsync(
    resolved.storageKey,
  );
  if (value == null || value.length === 0) {
    if (unreachable) {
      throw new CredentialResolutionError(
        "Credential store is unreachable — ensure the assistant is running",
      );
    }
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

  return value;
}

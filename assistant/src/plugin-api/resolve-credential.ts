/**
 * Plugin-facing credential resolution.
 *
 * {@link resolveCredential} returns a stored credential's plaintext value
 * (the same value `assistant credentials reveal` prints), resolving a
 * reference that is either a credential UUID or a `"service/field"` string,
 * exactly as the reveal path does (see
 * {@link ../tools/credentials/resolve.resolveCredentialRef} and the
 * `credentials/reveal` route).
 *
 * ## Plugin scoping
 *
 * When a plugin is in context (its hook, tool, or one of its own
 * `/x/plugins/<name>/` routes is executing, tracked by
 * {@link ../plugins/plugin-execution-context.getCurrentPluginName}), resolution
 * is restricted: the plugin may only resolve credentials whose `service`
 * equals its runtime name (`imessage/api_key` for plugin `imessage`). It
 * cannot read another service (`openai/api_key`, `openai/imessage`).
 *
 * A plugin-resident skill script or skill-tool subprocess presents a
 * daemon-issued invocation grant instead of in-process plugin context. The
 * daemon maps that grant to the catalog owner and scopes the read the same
 * way. Outside any plugin context or grant, the resolver is unscoped and
 * behaves like a direct reveal.
 */

import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";
import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { credentialInPluginScope } from "./credential-scope.js";
import { readPluginSkillGrantToken } from "./plugin-skill-grant.js";

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
  const grant = readPluginSkillGrantToken();
  const pluginName = getCurrentPluginName();
  if (grant !== undefined && pluginName === undefined) {
    return resolveCredentialViaGrant(grant, ref);
  }

  const resolved = resolveCredentialRef(ref);
  if (!resolved) {
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

  // Scope the resolution to the plugin in context, if any. The ownership gate
  // is enforced before the plaintext is read so an out-of-scope plugin never
  // touches the secure backend.
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
        "Credential store is unreachable. Ensure the assistant is running.",
      );
    }
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

  return value;
}

async function resolveCredentialViaGrant(
  token: string,
  ref: string,
): Promise<string> {
  const { cliIpcCall } = await import("../ipc/cli-client.js");
  const conversationId = process.env.__CONVERSATION_ID;
  const result = await cliIpcCall<{ value: string }>(
    "plugin_skill_resolve_credential",
    {
      body: {
        grant: token,
        ref,
        conversationId:
          typeof conversationId === "string" && conversationId.length > 0
            ? conversationId
            : undefined,
      },
    },
  );
  if (!result.ok) {
    throw new CredentialResolutionError(
      result.error ?? `Credential not found: ${ref}`,
    );
  }
  if (result.result?.value == null || result.result.value.length === 0) {
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }
  return result.result.value;
}

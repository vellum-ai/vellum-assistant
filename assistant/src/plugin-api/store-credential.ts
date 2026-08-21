/**
 * Plugin-facing credential storage.
 *
 * {@link storeCredential} writes a credential's plaintext to the secure store,
 * the same write `assistant credentials set` performs, naming it either by an
 * existing credential's UUID or by a `"service/field"` string, the same
 * vocabulary {@link ./resolve-credential.resolveCredential} reads back. A
 * plugin that obtains a token for itself (an OAuth exchange it drives, a key a
 * user hands it through its own route) persists it here instead of inventing
 * its own on-disk secret file.
 *
 * ## Plugin scoping
 *
 * A plugin may only write credentials whose `service` equals its manifest
 * name (`imessage/api_key` for plugin `imessage`). It cannot write another
 * service (`openai/api_key`, `openai/imessage`). The name comes from the
 * execution context
 * ({@link ../plugins/plugin-execution-context.getCurrentPluginName}), which the
 * host establishes around a plugin's hook, tool, and route invocations.
 *
 * Unlike the read path, this **fails closed**: with no plugin in context there
 * is nobody to scope the write to, so it is refused rather than treated as an
 * unscoped host write. A plugin's module body is evaluated by the loader
 * outside any context, and an unscoped branch there would let top-level code
 * overwrite the user's own credentials. Host-internal callers that legitimately
 * write unscoped (the `credentials/set` route, the CLI behind it) compose
 * {@link ../tools/credentials/store.storeCredentialValue} directly. This
 * matches the plugin-owned index (`indexDocument`), which likewise requires a
 * context because a write with no owner has nothing to attribute.
 */

import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";
import { parseServiceFieldRef } from "../tools/credentials/ref-parse.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { storeCredentialValue } from "../tools/credentials/store.js";
import { credentialInPluginScope } from "./credential-scope.js";

/**
 * Raised when a credential cannot be stored: the reference is malformed, the
 * value is empty or invalid for its service, the secure backend rejected the
 * write, or the calling plugin is not permitted to write the credential.
 */
export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export interface StoreCredentialOptions {
  /** Human-friendly alias shown in credential listings. */
  label?: string;
  /** What the credential is for, surfaced to the agent. */
  description?: string;
  /**
   * Skip the retroactive sweep that removes the value from recent transcripts.
   * The sweep exists because a secret is often pasted into chat before it is
   * stored; pass `true` only for a value that provably never transited a
   * conversation, such as a token minted by an OAuth refresh.
   */
  skipTranscriptScrub?: boolean;
}

/** Identity of the credential that was written. */
export interface StoredCredentialRef {
  credentialId: string;
  service: string;
  field: string;
}

/**
 * Store a credential's plaintext value, creating it or replacing the value of
 * an existing one.
 *
 * @param ref A credential UUID (an existing credential) or a `"service/field"`
 *   string (created when no such credential exists).
 * @param value The plaintext value. Edge whitespace is trimmed.
 * @returns The identity of the stored credential, which
 *   {@link ./resolve-credential.resolveCredential} accepts as a ref.
 * @throws {CredentialStoreError} when no plugin is in context, the ref is
 *   malformed or names no credential, the value is empty or invalid for its
 *   service, the store rejects the write, or the calling plugin is not scoped
 *   to the credential.
 */
export async function storeCredential(
  ref: string,
  value: string,
  options: StoreCredentialOptions = {},
): Promise<StoredCredentialRef> {
  // Both gates run before anything is written, so a refused write never
  // touches the secure backend. Fail closed when there is no plugin to scope
  // to: a plugin's module body is evaluated outside any context, and an
  // unscoped branch there would be a way to overwrite the user's credentials.
  const pluginName = getCurrentPluginName();
  if (pluginName === undefined) {
    throw new CredentialStoreError(
      "storeCredential requires an active plugin execution context (no calling plugin found). " +
        "Call it from a hook, tool, or route handler rather than at module scope.",
    );
  }

  const target = resolveStoreTarget(ref);
  if (!credentialInPluginScope(pluginName, target.service)) {
    throw new CredentialStoreError(
      `Plugin "${pluginName}" may only store credentials under its own service; ` +
        `"${target.service}/${target.field}" is out of scope.`,
    );
  }

  try {
    return await storeCredentialValue({
      service: target.service,
      field: target.field,
      value,
      alias: options.label,
      usageDescription: options.description,
      skipTranscriptScrub: options.skipTranscriptScrub,
    });
  } catch (err) {
    throw new CredentialStoreError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolve the `ref` a write targets. An existing credential (by UUID or by
 * `"service/field"`) keeps its identity; otherwise the ref must name the
 * service and field of the credential to create, which a bare UUID cannot.
 */
function resolveStoreTarget(ref: string): { service: string; field: string } {
  if (!ref || ref.trim().length === 0) {
    throw new CredentialStoreError("Credential reference is required");
  }

  const existing = resolveCredentialRef(ref);
  if (existing) {
    return { service: existing.service, field: existing.field };
  }

  const parsed = parseServiceFieldRef(ref);
  if (!parsed) {
    throw new CredentialStoreError(
      `Cannot store credential: "${ref}" matches no stored credential and is not a "service/field" reference`,
    );
  }
  return parsed;
}

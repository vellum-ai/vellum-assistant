/**
 * Plugin-facing credential storage.
 *
 * {@link storeCredential} writes a credential's plaintext to the secure store —
 * the same write `assistant credentials set` performs — naming it either by an
 * existing credential's UUID or by a `"service/field"` string, the same
 * vocabulary {@link ./resolve-credential.resolveCredential} reads back. A
 * plugin that obtains a token for itself (an OAuth exchange it drives, a key a
 * user hands it through its own route) persists it here instead of inventing
 * its own on-disk secret file.
 *
 * ## Plugin scoping
 *
 * Scoping mirrors the read path exactly. When a plugin is in context — its
 * hook, tool, or one of its own `/x/plugins/<name>/` routes is executing,
 * tracked by {@link ../plugins/plugin-execution-context.getCurrentPluginName} —
 * it may only write credentials whose `field` equals its manifest name. A plugin
 * named `acme` can therefore write `openai/acme` or `stripe/acme` but never
 * `openai/api_key`, so a plugin can neither read nor overwrite the user's own
 * credentials. Outside any plugin context (host-internal callers, CLI, tests)
 * the writer is unscoped and behaves like a direct `credentials set`.
 */

import { getCurrentPluginName } from "../plugins/plugin-execution-context.js";
import {
  parseServiceFieldRef,
  resolveCredentialRef,
} from "../tools/credentials/resolve.js";
import { storeCredentialValue } from "../tools/credentials/store.js";

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
 * @throws {CredentialStoreError} when the ref is malformed or names no
 *   credential, the value is empty or invalid for its service, the store
 *   rejects the write, or a plugin in context is not scoped to the credential.
 */
export async function storeCredential(
  ref: string,
  value: string,
  options: StoreCredentialOptions = {},
): Promise<StoredCredentialRef> {
  const target = resolveStoreTarget(ref);

  // Scope the write to the plugin in context, if any. The field-name gate is
  // enforced before anything is written so an out-of-scope plugin never
  // touches the secure backend.
  const pluginName = getCurrentPluginName();
  if (pluginName !== undefined && target.field !== pluginName) {
    throw new CredentialStoreError(
      `Plugin "${pluginName}" may only store credentials whose field matches its name; ` +
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

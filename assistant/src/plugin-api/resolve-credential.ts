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
 * When a plugin is in context, resolution is restricted to credentials
 * whose `service` equals the plugin's runtime install-directory name
 * (`sms/account_sid` for plugin `sms`). Context is:
 *
 * 1. In-process AsyncLocalStorage from `runInPluginContext` (hooks, plugin
 *    tools, plugin routes).
 * 2. `VELLUM_PLUGIN_NAME` on a bash or skill-sandbox child.
 * 3. The process entry path, when it sits under
 *    `plugins/<service>/skills/<skill>/{scripts,tools}/`.
 *
 * Outside any plugin context the resolver is unscoped and behaves like a
 * direct reveal. A standalone child has an empty in-process metadata
 * cache; when plugin context is set, a cache miss consults the live
 * credential catalog so an empty cache is not reported as "not found".
 */

import { credentialKey } from "@vellumai/credential-storage";

import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import {
  type CredentialMetadata,
  listCredentialRecordsLive,
} from "../tools/credentials/metadata-store.js";
import { parseServiceFieldRef } from "../tools/credentials/ref-parse.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { credentialInPluginScope } from "./credential-scope.js";
import { resolveCallingPluginName } from "./plugin-name-env.js";

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

interface ResolvedRef {
  service: string;
  field: string;
  storageKey: string;
}

function findLiveRecord(
  records: CredentialMetadata[],
  ref: string,
): CredentialMetadata | undefined {
  const byId = records.find((record) => record.credentialId === ref);
  if (byId) {
    return byId;
  }
  const parsed = parseServiceFieldRef(ref);
  if (!parsed) {
    return undefined;
  }
  return records.find(
    (record) =>
      record.service === parsed.service && record.field === parsed.field,
  );
}

async function resolveCredentialRefLive(
  ref: string,
): Promise<ResolvedRef | undefined> {
  const live = await listCredentialRecordsLive();
  if (live.unreachable) {
    throw new CredentialResolutionError(
      "Credential store is unreachable.",
    );
  }
  const record = findLiveRecord(live.records, ref);
  if (!record) {
    return undefined;
  }
  return {
    service: record.service,
    field: record.field,
    storageKey: credentialKey(record.service, record.field),
  };
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
  const pluginName = resolveCallingPluginName();

  let resolved: ResolvedRef | undefined = resolveCredentialRef(ref);
  if (!resolved && pluginName !== undefined) {
    resolved = await resolveCredentialRefLive(ref);
  }
  if (!resolved) {
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

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
        "Credential store is unreachable.",
      );
    }
    throw new CredentialResolutionError(`Credential not found: ${ref}`);
  }

  return value;
}

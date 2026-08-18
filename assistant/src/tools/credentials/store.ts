/**
 * Credential write path. The single sequence every "store a credential"
 * caller runs.
 *
 * Storing a credential is not one write: the plaintext goes to the secure
 * backend, the value is scrubbed from recent transcripts, the metadata record
 * is upserted, and manual-token providers reconcile their connection row.
 * Order matters (see {@link storeCredentialValue}), so the sequence lives here
 * rather than being re-typed per entry point. The `credentials/set` route and
 * the plugin-facing {@link ../../plugin-api/store-credential.storeCredential}
 * both compose it.
 *
 * The transcript scrub and the connection sync are imported lazily, at the
 * point of use. Both pull heavy graphs behind them (the scrub reaches the
 * conversation database and registry; the sync reaches the OAuth store), and
 * this module sits under `@vellumai/plugin-api`, so a static edge would drag
 * that machinery into every plugin-api consumer for a write most of them never
 * perform.
 *
 * Callers own their own transport-level argument validation and error mapping;
 * this module throws {@link InvalidCredentialInputError} for a value it will
 * not store and {@link CredentialStorageError} when the secure backend write
 * fails.
 */

import {
  ACP_SERVICE,
  assertAcpCredentialFormat,
} from "../../acp/acp-credentials.js";
import { credentialKey } from "../../security/credential-key.js";
import { normalizeSecretValue } from "../../security/secret-normalize.js";
import {
  getActiveBackendName,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  assertMetadataWritable,
  upsertCredentialMetadata,
} from "./metadata-store.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

const log = getLogger("credential-store");

/** Raised for a value the store refuses before writing anything. */
export class InvalidCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCredentialInputError";
  }
}

/** Raised when the secure backend write itself fails. */
export class CredentialStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStorageError";
  }
}

export interface StoreCredentialValueInput {
  service: string;
  field: string;
  /** Plaintext value. Edge whitespace is trimmed before storage. */
  value: string;
  /** Human-friendly alias shown in credential listings. */
  alias?: string;
  /** What the credential is for, surfaced to the agent. */
  usageDescription?: string;
  allowedTools?: string[];
  allowedDomains?: string[];
  injectionTemplates?: CredentialInjectionTemplate[];
  /**
   * Skip the retroactive transcript scrub. Set it only when the plaintext
   * provably never transited a conversation (a token minted by an OAuth
   * refresh, say), since the scrub is a bounded but real sweep of recent
   * history.
   */
  skipTranscriptScrub?: boolean;
}

export interface StoredCredential {
  credentialId: string;
  service: string;
  field: string;
}

/**
 * Store a credential's plaintext and reconcile everything that hangs off it.
 *
 * The order is load-bearing:
 * 1. Validate the value (and the ACP format guard) so a rejected write leaves
 *    no side effects.
 * 2. Fail early when credential metadata is not writable.
 * 3. Write the plaintext to the secure backend.
 * 4. Scrub the value from recent transcripts. This runs BEFORE the metadata
 *    upsert and the connection sync, because those can throw and a
 *    stored-but-unscrubbed secret must not depend on them succeeding. The
 *    credential IS stored at this point, so the scrub is best-effort hygiene
 *    and stays invisible to the caller.
 * 5. Upsert metadata and reconcile the manual-token connection row.
 *
 * @throws {InvalidCredentialInputError} when the value is empty or malformed
 *   for its service.
 * @throws {CredentialStorageError} when the secure backend rejects the write.
 */
export async function storeCredentialValue(
  input: StoreCredentialValueInput,
): Promise<StoredCredential> {
  const { service, field } = input;

  const value = normalizeSecretValue(input.value);
  if (value.length === 0) {
    throw new InvalidCredentialInputError("value is required");
  }

  // Reject an Anthropic API key pasted into the ACP OAuth-token field (a 401
  // footgun) before it reaches storage.
  if (service === ACP_SERVICE) {
    assertAcpCredentialFormat(field, value);
  }

  assertMetadataWritable();

  const stored = await setSecureKeyAsync(credentialKey(service, field), value);
  if (!stored) {
    throw new CredentialStorageError(
      `Failed to store credential in secure storage (backend: ${getActiveBackendName()})`,
    );
  }

  // The stored plaintext may already sit in recent transcripts: the user
  // message that pasted it, the persisted tool_use input, the tool result
  // echoing the command. This is the scrub seam, not setSecureKeyAsync, which
  // also fires on OAuth refresh rotations and MCP header writes whose values
  // never transited a transcript.
  if (!input.skipTranscriptScrub) {
    const { isNonSecretPlatformField, scrubStoredCredentialFromTranscripts } =
      await import("../../daemon/credential-transcript-scrub.js");
    if (!isNonSecretPlatformField(service, field)) {
      try {
        const scrubbed = await scrubStoredCredentialFromTranscripts(value);
        log.info(
          { service, field, ...scrubbed },
          "Credential stored; scrubbed value from recent transcripts",
        );
      } catch (err) {
        log.warn(
          { err, service, field },
          "Credential stored, but transcript scrub failed",
        );
      }
    }
  }

  const metadata = upsertCredentialMetadata(service, field, {
    alias: input.alias,
    usageDescription: input.usageDescription,
    allowedTools: input.allowedTools,
    allowedDomains: input.allowedDomains,
    injectionTemplates: input.injectionTemplates,
  });
  const { syncManualTokenConnection } =
    await import("../../oauth/manual-token-connection.js");
  await syncManualTokenConnection(service);

  return { credentialId: metadata.credentialId, service, field };
}

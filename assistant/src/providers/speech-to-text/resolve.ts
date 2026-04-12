import { getConfig } from "../../config/loader.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type { BatchTranscriber, SttProviderId } from "../../stt/types.js";

// ---------------------------------------------------------------------------
// Provider-to-credential mapping
// ---------------------------------------------------------------------------

/**
 * Map an STT provider identifier to the credential provider name used by
 * `getProviderKeyAsync`. New STT providers that share credentials with an
 * existing credential provider (e.g. a future Deepgram provider would map
 * to `"deepgram"`) add an entry here.
 *
 * Typed as `Record<SttProviderId, string>` to ensure compile-time
 * completeness: adding a new variant to `SttProviderId` without a
 * corresponding entry here is a type error.
 */
const STT_PROVIDER_CREDENTIAL_MAP: Record<SttProviderId, string> = {
  "openai-whisper": "openai",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a `BatchTranscriber` for daemon-hosted batch transcription.
 *
 * Reads `services.stt.provider` from the assistant config to determine which
 * STT provider to use, then looks up the corresponding credential. Credential
 * lookup is centralized here (an authorized secure-keys importer) so callers
 * don't need to import secure-keys directly.
 *
 * Returns `null` when:
 * - The configured provider is not supported by the daemon-batch boundary.
 * - No credentials are configured for the resolved provider.
 */
export async function resolveBatchTranscriber(): Promise<BatchTranscriber | null> {
  const config = getConfig();
  const provider = config.services.stt.provider;

  // Resolve the credential provider name for the configured STT provider.
  // Cast to `string` for the lookup so that unknown providers (which can
  // arrive at runtime despite the schema validation) produce `undefined`
  // instead of a type error. This keeps the runtime guard meaningful.
  const credentialProvider = STT_PROVIDER_CREDENTIAL_MAP[
    provider as SttProviderId
  ] as string | undefined;
  if (!credentialProvider) {
    return null;
  }

  const apiKey = await getProviderKeyAsync(credentialProvider);
  return createDaemonBatchTranscriber(apiKey);
}

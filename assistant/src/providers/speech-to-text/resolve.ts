import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { createDaemonBatchTranscriber } from "../../stt/daemon-batch-transcriber.js";
import type { BatchTranscriber } from "../../stt/types.js";

/**
 * Resolve a `BatchTranscriber` for daemon-hosted batch transcription.
 *
 * Credential lookup is centralized here (an authorized secure-keys importer)
 * so callers don't need to import secure-keys directly.
 *
 * Returns `null` when no STT credentials are configured.
 */
export async function resolveBatchTranscriber(): Promise<BatchTranscriber | null> {
  const apiKey = await getProviderKeyAsync("openai");
  return createDaemonBatchTranscriber(apiKey);
}

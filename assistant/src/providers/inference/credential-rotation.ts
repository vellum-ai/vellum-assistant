/**
 * Refreshes provider state after a credential rotation.
 */

import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import { evictConversationsForReload } from "../../daemon/conversation-store.js";
import { clearEmbeddingBackendCache } from "../../persistence/embeddings/embedding-backend.js";
import { credentialKey } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import { initializeProviders } from "../registry.js";
import { findConnectionsUsingCredential } from "./credential-usage.js";

const log = getLogger("credential-rotation");

export async function refreshProvidersAfterSecretChange(): Promise<void> {
  clearEmbeddingBackendCache();
  invalidateConfigCache();
  await initializeProviders(getConfig());

  // Provider instances are captured when conversations are created, so a key
  // change must evict or mark them stale before the next turn. Best-effort:
  // the credential write has already succeeded, so a disposal failure must not
  // surface as a 500 that makes clients think the secret change failed.
  try {
    evictConversationsForReload();
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Error evicting conversations after credential change (non-fatal)",
    );
  }
}

export async function refreshProvidersForRotatedCredential(
  service: string,
  field: string,
): Promise<void> {
  const key = credentialKey(service, field);

  // A connection resolves its auth through this credential account, and
  // the resolved adapter bakes the key it read into its headers, so the
  // rotation only reaches dispatch once the cached adapter is dropped.
  // The credential write has already succeeded: an enumeration failure
  // refreshes rather than surfacing as a 500.
  try {
    const connections = findConnectionsUsingCredential(key);
    if (connections.length > 0) {
      await refreshProvidersAfterSecretChange();
    }
  } catch (err) {
    log.warn(
      {
        service,
        field,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to inspect provider connections after credential update; refreshing providers anyway",
    );
    await refreshProvidersAfterSecretChange();
  }
}

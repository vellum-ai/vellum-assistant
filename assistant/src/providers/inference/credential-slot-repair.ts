import type { DrizzleDb } from "../../persistence/db-connection.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  getSecureKeyResultAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import {
  getConnection,
  listConnections,
  updateConnection,
} from "./connections.js";

const log = getLogger("providers/credential-slot-repair");

/**
 * The provider-keyed vault ref that unrepaired openai-compatible connections
 * share. One slot for N endpoints means saving any endpoint's key overwrites
 * the key every sibling resolves — the repair repoints each row at its own
 * per-connection slot (`credential/<connection-name>/api_key`).
 */
const LEGACY_SHARED_REF = credentialKey("openai-compatible", "api_key");

/**
 * Repoint openai-compatible connections still referencing the shared legacy
 * credential slot onto per-connection slots.
 *
 * Per row: copy the shared slot's current value into the row's own slot
 * (behavior-preserving — the shared value is what the row resolves; any
 * key overwritten inside the shared slot is unrecoverable), then
 * rewrite the row's ref. Rows are only rewritten after their slot is settled,
 * so a vault outage mid-repair leaves the remaining rows on the legacy ref
 * to be repaired on a later boot. Idempotent: a repaired row does not match
 * the legacy ref.
 */
export async function repairSharedCredentialSlots(
  db: DrizzleDb,
): Promise<void> {
  const rows = listConnections(db, { provider: "openai-compatible" });
  const sharing = rows.filter(
    (row) =>
      row.auth.type === "api_key" && row.auth.credential === LEGACY_SHARED_REF,
  );
  if (sharing.length === 0) {
    return;
  }

  const shared = await getSecureKeyResultAsync(LEGACY_SHARED_REF);
  if (shared.unreachable) {
    log.warn(
      { connections: sharing.map((row) => row.name) },
      "Credential vault unreachable — shared-slot repair deferred to a later boot",
    );
    return;
  }

  for (const row of sharing) {
    const target = credentialKey(row.name, "api_key");
    try {
      if (shared.value != null) {
        const existing = await getSecureKeyResultAsync(target);
        if (existing.unreachable) {
          log.warn(
            { connection: row.name },
            "Credential vault unreachable — leaving this connection on the shared slot",
          );
          continue;
        }
        if (existing.value == null) {
          await setSecureKeyAsync(target, shared.value);
        }
      }
      // Re-read synchronously after the vault awaits: the repair runs
      // concurrently with client mutations, and a row rewritten (or
      // deleted and recreated) mid-await must not have its fresh auth
      // clobbered with the repair target. The check and the update share
      // one event-loop turn, so no mutation can interleave.
      const current = getConnection(db, row.name);
      if (
        current?.auth.type !== "api_key" ||
        current.auth.credential !== LEGACY_SHARED_REF
      ) {
        log.info(
          { connection: row.name },
          "Connection changed during repair — leaving it as-is",
        );
        continue;
      }
      const updated = updateConnection(db, row.name, {
        auth: { type: "api_key", credential: target },
      });
      if (updated.ok) {
        log.info(
          { connection: row.name, credential: target },
          "Repointed shared credential slot to a per-connection slot",
        );
      } else {
        log.warn(
          { connection: row.name, error: updated.error },
          "Failed to repoint shared credential slot",
        );
      }
    } catch (err) {
      log.warn(
        { err, connection: row.name },
        "Shared-slot repair failed for connection — deferred to a later boot",
      );
    }
  }
}

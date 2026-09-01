/**
 * Pull-based identity reconciliation of the assistant contact mirror against
 * the gateway DB (the source of truth for contact identity and channel
 * ownership).
 *
 * The gateway's per-write mirror ops are best-effort: a failed or lost op
 * leaves the mirror missing a row, or holding a channel under the wrong
 * contact, until something happens to write that identity again. This module
 * converges the drift instead: on the debounced `contacts_changed` signal it
 * pulls the gateway's identity snapshot and heals the mirror toward it.
 *
 * Additive-corrective ONLY, because the mirror holds data the gateway cannot
 * reconstruct:
 *
 * - It never deletes a mirror row. Mirror-only contacts and channels are
 *   legitimate (a2a peers are written daemon-side only), and absence from
 *   the gateway is indistinguishable from "the gateway never had it".
 *   Delete propagation stays on the explicit delete ops.
 * - It never touches assistant-authored fields (notes, contactType,
 *   userFile) or an existing contact's displayName (the mirror name tracks
 *   the live platform profile, not the gateway's curated name).
 *
 * Convergence is a fixed point: a pass only writes rows that diverge from
 * the snapshot, so the follow-up pass its own writes trigger (every mirror
 * write broadcasts `contacts_changed`) finds nothing to do and stops.
 *
 * TRANSITIONAL: this module exists only while the assistant DB keeps its own
 * copy of identity columns. When identity reads move to the gateway
 * wholesale, the mirror's identity columns and this reconciler go with them;
 * do not grow it into a general sync framework.
 */

import { ContactsIdentitySnapshotIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { getDbMigrationReadiness } from "../daemon/daemon-readiness.js";
import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getDb } from "../persistence/db-connection.js";
import { contactChannels, contacts } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { upsertContact } from "./contact-store.js";
import { upsertContactChannel } from "./contacts-write.js";
import { isContactTombstoned } from "./mirror-tombstones.js";

const log = getLogger("mirror-reconciler");

/**
 * Collapse bursts of contacts_changed into one pull. Every inbound message
 * from a known sender refreshes its channel row and notifies, so under
 * continuous traffic this is the steady-state floor between snapshot pulls;
 * healing latency is deliberately loose (the next quiet moment is fine).
 */
const DEBOUNCE_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let rerunRequested = false;

/**
 * Ask for a reconcile pass soon. Called (via dynamic import) from
 * `notifyContactsChanged`, so every contact write, gateway-emitted or
 * daemon-local, requests convergence. Coalesces bursts; a request landing
 * while a pass is running (including the pass's own writes re-notifying)
 * runs one follow-up pass after it, whose no-op result ends the cycle.
 */
export function scheduleMirrorReconcile(): void {
  if (running) {
    rerunRequested = true;
    return;
  }
  if (timer) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void runMirrorReconcile();
  }, DEBOUNCE_MS);
  // A pending debounce must never hold the process open (daemon shutdown,
  // test teardown); a lost pass is re-requested by the next contact write.
  timer.unref?.();
}

/**
 * Key channels by (type, lower(address)), matching the gateway's
 * UNIQUE(type, address) NOCASE collation. The NUL delimiter cannot appear in
 * either field, so keys never collide.
 */
function channelKey(type: string, address: string): string {
  return `${type}\u0000${address.toLowerCase()}`;
}

/**
 * One reconcile pass: pull the gateway identity snapshot and heal every
 * diverging mirror row through the identity-mirror primitives (which own the
 * conflict semantics: gateway ids adopted on create, ownership reassigned to
 * the gateway's contact, curated fields preserved). Best-effort: errors are
 * logged, never thrown.
 */
export async function runMirrorReconcile(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return;
  }
  if (!getDbMigrationReadiness().ready) {
    return;
  }
  running = true;
  try {
    const result = await ipcCallPersistent("contacts_identity_snapshot", {});
    const snapshot = ContactsIdentitySnapshotIpcResponseSchema.parse(result);

    const db = getDb();
    const localContactIds = new Set(
      db
        .select({ id: contacts.id })
        .from(contacts)
        .all()
        .map((r) => r.id),
    );
    const localByTypeAddress = new Map(
      db
        .select({
          id: contactChannels.id,
          contactId: contactChannels.contactId,
          type: contactChannels.type,
          address: contactChannels.address,
          externalChatId: contactChannels.externalChatId,
          isPrimary: contactChannels.isPrimary,
        })
        .from(contactChannels)
        .all()
        .map((row) => [channelKey(row.type, row.address), row]),
    );

    let healed = 0;
    for (const contact of snapshot.contacts) {
      // A contact deleted (or merged away) after this snapshot was pulled
      // must not be resurrected from it; the additive contract would keep
      // the ghost forever.
      if (isContactTombstoned(contact.id)) {
        continue;
      }
      if (contact.channels.length === 0) {
        // A channel-less gateway contact (a guardian-authored record) whose
        // mirror row is missing: recreate the identity stub.
        if (!localContactIds.has(contact.id)) {
          upsertContact({
            id: contact.id,
            displayName: contact.displayName,
            userFileOnCreate: null,
          });
          healed += 1;
        }
        continue;
      }

      for (const channel of contact.channels) {
        const local = localByTypeAddress.get(
          channelKey(channel.type, channel.address),
        );
        // A gateway-null externalChatId means the delivery chat id was
        // never learned (clearing one is off the upsert contract), so the
        // mirror's value is the richer of the two and is not divergence. A
        // divergent channel id IS: the heal adopts the gateway id (see
        // syncChannels), so id-keyed read-backs and client PATCHes resolve
        // directly instead of through the logical-key fallback forever.
        const diverges =
          !local ||
          local.id !== channel.id ||
          local.contactId !== contact.id ||
          (channel.externalChatId != null &&
            local.externalChatId !== channel.externalChatId) ||
          local.isPrimary !== channel.isPrimary;
        if (!diverges) {
          continue;
        }
        // The identity-mirror primitive adopts the gateway ids on create,
        // reassigns a divergent owner (the gateway owns channel ownership),
        // and preserves an existing contact's curated name and record fields.
        upsertContactChannel({
          sourceChannel: channel.type,
          externalUserId: channel.address,
          externalChatId: channel.externalChatId ?? undefined,
          displayName: contact.displayName,
          contactId: contact.id,
          channelId: channel.id,
          refreshDisplayName: false,
          reassignConflictingChannels: true,
          isPrimary: channel.isPrimary,
          userFileOnCreate: null,
        });
        healed += 1;
      }
    }

    if (healed > 0) {
      log.info(
        { healed },
        "mirror reconciler converged identity rows onto the gateway snapshot",
      );
    }
  } catch (err) {
    log.warn({ err }, "mirror reconcile failed (best-effort)");
  } finally {
    running = false;
    if (rerunRequested) {
      rerunRequested = false;
      scheduleMirrorReconcile();
    }
  }
}

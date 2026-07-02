/**
 * Transactional identity-mirror IPC (`contacts_mirror_apply`) against the REAL
 * assistant DB (via `initializeDb()`; the test preload points
 * VELLUM_WORKSPACE_DIR at a per-file temp dir).
 *
 * Covers the guardian-bootstrap-shaped upsert end to end, a multi-op batch
 * committing together, and the re-auth rebind (an existing channel id rebound
 * to a new address updates in place instead of colliding). Mid-batch rollback
 * lives in contacts-mirror-apply-atomicity.test.ts (needs an injected throw).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  handleContactsMirrorApply,
  handleContactsMirrorUpsertChannel,
} from "../contacts-mirror-ipc-routes.js";

await initializeDb();

function resetContacts(): void {
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM contact_channels");
  sqlite.exec("DELETE FROM contacts");
}

function contactExists(id: string): boolean {
  return (
    getSqlite().prepare("SELECT 1 FROM contacts WHERE id = ?").get(id) != null
  );
}

function channelRow(
  id: string,
): { contact_id: string; is_primary: number; external_chat_id: string | null } | null {
  return (
    (getSqlite()
      .prepare(
        "SELECT contact_id, is_primary, external_chat_id FROM contact_channels WHERE id = ?",
      )
      .get(id) as
      | { contact_id: string; is_primary: number; external_chat_id: string | null }
      | undefined) ?? null
  );
}

describe("contacts_mirror_apply", () => {
  beforeEach(() => {
    resetContacts();
  });

  test("applies a guardian-bootstrap-shaped upsert (contact + primary channel) end to end", () => {
    const result = handleContactsMirrorApply({
      body: {
        ops: [
          {
            op: "upsert_channel",
            contactId: "guardian-co",
            channelId: "guardian-ch",
            type: "vellum",
            address: "vellum-principal-abc",
            externalChatId: "local",
            displayName: "Owner",
            isPrimary: true,
            refreshDisplayName: true,
            reassignConflictingChannels: true,
          },
        ],
      },
    });

    expect(result).toEqual({ ok: true });
    expect(contactExists("guardian-co")).toBe(true);
    const ch = channelRow("guardian-ch");
    expect(ch?.contact_id).toBe("guardian-co");
    // The guardian channel keeps its primary flag and delivery chat id.
    expect(ch?.is_primary).toBe(1);
    expect(ch?.external_chat_id).toBe("local");
  });

  test("commits a multi-op batch atomically", () => {
    handleContactsMirrorApply({
      body: {
        ops: [
          { op: "upsert_contact", contactId: "co-a", displayName: "A" },
          {
            op: "upsert_channel",
            contactId: "co-a",
            channelId: "ch-a",
            type: "telegram",
            address: "tg-a",
            displayName: "A",
          },
        ],
      },
    });

    expect(contactExists("co-a")).toBe(true);
    expect(channelRow("ch-a")?.contact_id).toBe("co-a");
  });

  test("re-auth rebind: updates an existing channel's address in place by id", () => {
    // A guardian channel already mirrored at the OLD actor address.
    const sqlite = getSqlite();
    sqlite
      .prepare(
        "INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("g-co", "Owner", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run("g-ch", "g-co", "vellum", "OLD-principal", 1);

    // The gateway rebinds the SAME channel id to a NEW address (re-auth). The op
    // must update row g-ch in place, not collide on its id and silently keep the
    // stale address.
    const result = handleContactsMirrorApply({
      body: {
        ops: [
          {
            op: "upsert_channel",
            contactId: "g-co",
            channelId: "g-ch",
            type: "vellum",
            address: "NEW-principal",
            externalChatId: "local",
            displayName: "Owner",
            isPrimary: true,
            refreshDisplayName: true,
            reassignConflictingChannels: true,
          },
        ],
      },
    });

    expect(result).toEqual({ ok: true });
    const row = getSqlite()
      .prepare(
        "SELECT contact_id, address, is_primary, external_chat_id FROM contact_channels WHERE id = ?",
      )
      .get("g-ch");
    expect(row).toEqual({
      contact_id: "g-co",
      address: "NEW-principal",
      is_primary: 1,
      external_chat_id: "local",
    });
    // Exactly one row — no duplicate from a collided insert, no stale sibling.
    const count = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM contact_channels")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("re-auth rebind also works through the single-row upsert_channel handler", () => {
    const sqlite = getSqlite();
    sqlite
      .prepare(
        "INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("g2-co", "Owner", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run("g2-ch", "g2-co", "vellum", "OLD-2", 1);

    // The single-row handler shares the same applier/primitive as the apply op.
    handleContactsMirrorUpsertChannel({
      body: {
        contactId: "g2-co",
        channelId: "g2-ch",
        type: "vellum",
        address: "NEW-2",
        displayName: "Owner",
        isPrimary: true,
        refreshDisplayName: true,
        reassignConflictingChannels: true,
      },
    });

    const row = getSqlite()
      .prepare("SELECT address FROM contact_channels WHERE id = ?")
      .get("g2-ch") as { address: string };
    expect(row.address).toBe("NEW-2");
    const count = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM contact_channels")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("re-auth rebind adopts a (type,address) held by another row instead of colliding on the unique index", () => {
    const sqlite = getSqlite();
    // Guardian channel at the OLD address.
    sqlite
      .prepare(
        "INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("g3-co", "Owner", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run("g3-ch", "g3-co", "vellum", "OLD-3", 1);
    // A DIFFERENT row (different contact) already holds (vellum, NEW-3) — the
    // address the guardian is about to rebind to. idx_contact_channels_type_address
    // would reject a naive address move.
    sqlite
      .prepare(
        "INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("stale-co", "Stale", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .run("stale-ch", "stale-co", "vellum", "NEW-3", 1);

    // reassignConflictingChannels:true (guardian) → adopt the identity onto the
    // gateway-keyed row: remove the stale duplicate, land g3-ch on NEW-3, no throw.
    const result = handleContactsMirrorApply({
      body: {
        ops: [
          {
            op: "upsert_channel",
            contactId: "g3-co",
            channelId: "g3-ch",
            type: "vellum",
            address: "NEW-3",
            displayName: "Owner",
            isPrimary: true,
            refreshDisplayName: true,
            reassignConflictingChannels: true,
          },
        ],
      },
    });

    expect(result).toEqual({ ok: true });
    // The gateway-keyed row survived and moved to the new address.
    const g3 = getSqlite()
      .prepare("SELECT contact_id, address, is_primary FROM contact_channels WHERE id = ?")
      .get("g3-ch");
    expect(g3).toEqual({ contact_id: "g3-co", address: "NEW-3", is_primary: 1 });
    // The stale duplicate is gone — exactly one channel row remains.
    expect(
      getSqlite().prepare("SELECT 1 FROM contact_channels WHERE id = ?").get("stale-ch"),
    ).toBeNull();
    const count = getSqlite()
      .prepare("SELECT COUNT(*) AS n FROM contact_channels")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("rejects an unknown op discriminator", () => {
    expect(() =>
      handleContactsMirrorApply({
        body: { ops: [{ op: "wipe_everything", contactId: "x" }] },
      }),
    ).toThrow();
  });

  test("rejects an empty ops array", () => {
    expect(() =>
      handleContactsMirrorApply({ body: { ops: [] } }),
    ).toThrow();
  });
});

/**
 * Transactional identity-mirror IPC (`contacts_mirror_apply`) against the REAL
 * assistant DB (via `initializeDb()`; the test preload points
 * VELLUM_WORKSPACE_DIR at a per-file temp dir).
 *
 * Proves the daemon-side batch is atomic — every op commits together and a
 * mid-batch failure rolls back the ENTIRE batch, so the mirror is never left
 * partially applied — plus the guardian-bootstrap-shaped upsert end to end.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { handleContactsMirrorApply } from "../contacts-mirror-ipc-routes.js";

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

  test("rolls back the ENTIRE batch when a later op fails mid-transaction", () => {
    // Pre-seed a channel whose id a later op will collide with (PK conflict).
    const sqlite = getSqlite();
    sqlite
      .prepare(
        "INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("existing-co", "Existing", 1, 1);
    sqlite
      .prepare(
        "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, interaction_count, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
      )
      .run("dup-ch", "existing-co", "slack", "U-existing", 1);

    expect(() =>
      handleContactsMirrorApply({
        body: {
          ops: [
            // op1: a fresh contact that MUST NOT survive the rollback.
            { op: "upsert_contact", contactId: "rollback-co", displayName: "RB" },
            // op2: inserting a new channel with the pre-seeded id collides on the
            // primary key and throws, aborting the whole transaction.
            {
              op: "upsert_channel",
              contactId: "rollback-co",
              channelId: "dup-ch",
              type: "telegram",
              address: "tg-rollback",
              displayName: "RB",
            },
          ],
        },
      }),
    ).toThrow();

    // op1 rolled back: no partial mirror.
    expect(contactExists("rollback-co")).toBe(false);
    // The pre-seeded channel is untouched (still owned by existing-co).
    expect(channelRow("dup-ch")?.contact_id).toBe("existing-co");
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

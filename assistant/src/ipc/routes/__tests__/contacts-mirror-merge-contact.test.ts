/**
 * Transactional merge-mirror IPC (`contacts_mirror_merge_contact`) against the
 * REAL assistant DB. Pins the semantics the gateway's raw merge-mirror SQL had
 * (byte-identical notes concat, logical-key channel reparent, donor delete,
 * dual-write-gap survivor INSERT) plus the new guarantees: one transaction
 * (induced-failure rollback) and idempotent retry (donor gone → no-op).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { handleContactsMirrorMergeContact } from "../contacts-mirror-ipc-routes.js";

await initializeDb();

function seedContact(
  id: string,
  opts: { displayName?: string; notes?: string | null; userFile?: string | null } = {},
): void {
  getSqlite()
    .prepare(
      "INSERT INTO contacts (id, display_name, notes, user_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, opts.displayName ?? `name-${id}`, opts.notes ?? null, opts.userFile ?? null, 100, 100);
}

function seedChannel(
  id: string,
  contactId: string,
  opts: { type?: string; address?: string } = {},
): void {
  getSqlite()
    .prepare(
      "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    )
    .run(id, contactId, opts.type ?? "slack", opts.address ?? `addr-${id}`, 100);
}

function contactRow(
  id: string,
): { display_name: string; notes: string | null; user_file: string | null } | null {
  return (
    (getSqlite()
      .prepare("SELECT display_name, notes, user_file FROM contacts WHERE id = ?")
      .get(id) as
      | { display_name: string; notes: string | null; user_file: string | null }
      | undefined) ?? null
  );
}

function channelOwner(id: string): string | null {
  const row = getSqlite()
    .prepare("SELECT contact_id FROM contact_channels WHERE id = ?")
    .get(id) as { contact_id: string } | undefined;
  return row?.contact_id ?? null;
}

function merge(overrides: Record<string, unknown> = {}): unknown {
  return handleContactsMirrorMergeContact({
    body: {
      keepContactId: "co-keep",
      mergeContactId: "co-merge",
      keepDisplayName: "name-co-keep",
      ...overrides,
    },
  });
}

describe("contacts_mirror_merge_contact", () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.exec("DELETE FROM contact_channels");
    sqlite.exec("DELETE FROM contacts");
  });

  test("concats donor notes onto the survivor with \\n and deletes the donor", () => {
    seedContact("co-keep", { notes: "keep notes" });
    seedContact("co-merge", { notes: "merge notes" });

    expect(merge()).toEqual({ ok: true });
    // Byte-identical concat rule: [keep, merge].filter(Boolean).join("\n").
    expect(contactRow("co-keep")?.notes).toBe("keep notes\nmerge notes");
    expect(contactRow("co-merge")).toBeNull();
  });

  test("null-notes concat: falsy sides are dropped; both empty → null", () => {
    seedContact("co-keep", { notes: null });
    seedContact("co-merge", { notes: "only donor" });
    merge();
    expect(contactRow("co-keep")?.notes).toBe("only donor");

    seedContact("co-merge2", { notes: null });
    merge({ mergeContactId: "co-merge2" });
    expect(contactRow("co-keep")?.notes).toBe("only donor");

    getSqlite().prepare("UPDATE contacts SET notes = NULL WHERE id = ?").run("co-keep");
    seedContact("co-merge3", { notes: null });
    merge({ mergeContactId: "co-merge3" });
    expect(contactRow("co-keep")?.notes).toBeNull();
  });

  test("never clobbers the survivor's display name or user_file", () => {
    seedContact("co-keep", { displayName: "Curated Name", userFile: "curated.md" });
    seedContact("co-merge", { notes: "n" });

    merge({ keepDisplayName: "Gateway Name", resolvedUserFile: "gateway.md" });

    const row = contactRow("co-keep");
    expect(row?.display_name).toBe("Curated Name");
    expect(row?.user_file).toBe("curated.md");
  });

  test("reparents donor channels, skipping (type, address NOCASE) duplicates", () => {
    seedContact("co-keep");
    seedContact("co-merge");
    seedChannel("ch-keep", "co-keep", { type: "email", address: "A@x.com" });
    // Duplicate by logical key (case-insensitive address) — must NOT move.
    seedChannel("ch-dup", "co-merge", { type: "email", address: "a@X.com" });
    // Unique — must move to the survivor.
    seedChannel("ch-move", "co-merge", { type: "slack", address: "U123" });

    merge();

    expect(channelOwner("ch-move")).toBe("co-keep");
    expect(channelOwner("ch-keep")).toBe("co-keep");
    // The duplicate stayed on the donor and was cascade-deleted with it.
    expect(channelOwner("ch-dup")).toBeNull();
  });

  test("dual-write gap: inserts a missing survivor with combined notes and the resolved user_file", () => {
    seedContact("co-merge", { notes: "donor notes" });
    seedChannel("ch-1", "co-merge");

    merge({ keepDisplayName: "Keeper", resolvedUserFile: "keeper.md" });

    const row = contactRow("co-keep");
    expect(row).toEqual({
      display_name: "Keeper",
      notes: "donor notes",
      user_file: "keeper.md",
    });
    expect(channelOwner("ch-1")).toBe("co-keep");
    expect(contactRow("co-merge")).toBeNull();
  });

  test("dual-write gap without resolvedUserFile: survivor INSERT proceeds with null user_file", () => {
    seedContact("co-merge", { notes: "donor notes" });
    seedChannel("ch-1", "co-merge");

    // Gateway degrades resolvedUserFile to undefined when slug resolution
    // fails — the merge must still apply, with a null user_file.
    expect(merge({ keepDisplayName: "Keeper" })).toEqual({ ok: true });

    const row = contactRow("co-keep");
    expect(row).toEqual({
      display_name: "Keeper",
      notes: "donor notes",
      user_file: null,
    });
    expect(channelOwner("ch-1")).toBe("co-keep");
    expect(contactRow("co-merge")).toBeNull();
  });

  test("idempotent retry: donor already gone is a no-op success", () => {
    seedContact("co-keep", { notes: "keep notes" });
    seedContact("co-merge", { notes: "merge notes" });

    merge();
    expect(merge()).toEqual({ ok: true });
    // No double-concat, no survivor re-insert.
    expect(contactRow("co-keep")?.notes).toBe("keep notes\nmerge notes");
  });

  test("rolls back the WHOLE merge when a late step fails mid-transaction", () => {
    seedContact("co-keep", { notes: "keep notes" });
    seedContact("co-merge", { notes: "merge notes" });
    seedChannel("ch-1", "co-merge");

    // Induce a failure at the LAST step (donor delete) so the earlier notes
    // update + channel reparent must roll back.
    const sqlite = getSqlite();
    sqlite.exec(
      "CREATE TRIGGER fail_donor_delete BEFORE DELETE ON contacts WHEN OLD.id = 'co-merge' BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END",
    );
    try {
      expect(() => merge()).toThrow(/injected delete failure/);
    } finally {
      sqlite.exec("DROP TRIGGER fail_donor_delete");
    }

    // Nothing applied: no partial mirror merge.
    expect(contactRow("co-keep")?.notes).toBe("keep notes");
    expect(channelOwner("ch-1")).toBe("co-merge");
    expect(contactRow("co-merge")?.notes).toBe("merge notes");
  });
});

/**
 * Full identity-mirror upsert IPC (`contacts_mirror_upsert_full`) against the
 * REAL assistant DB. Pins the semantics of the gateway raw dual-write it
 * replaces (`dualWriteContactToAssistantDb`): sparse omit-to-preserve contact
 * update, slug-resolved user_file on create, assistant_contact_metadata
 * upsert (assistant-type only), channel conflict-skip + gateway-id adoption,
 * omit-to-preserve external_chat_id — plus the new guarantee: one transaction
 * (induced-failure rollback).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { handleContactsMirrorUpsertFull } from "../contacts-mirror-ipc-routes.js";

await initializeDb();

function seedContact(
  id: string,
  opts: {
    displayName?: string;
    notes?: string | null;
    userFile?: string | null;
    contactType?: string;
  } = {},
): void {
  getSqlite()
    .prepare(
      "INSERT INTO contacts (id, display_name, notes, user_file, contact_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      opts.displayName ?? `name-${id}`,
      opts.notes ?? null,
      opts.userFile ?? null,
      opts.contactType ?? "human",
      100,
      100,
    );
}

function seedChannel(
  id: string,
  contactId: string,
  opts: {
    type?: string;
    address?: string;
    isPrimary?: number;
    externalChatId?: string | null;
  } = {},
): void {
  getSqlite()
    .prepare(
      "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      contactId,
      opts.type ?? "slack",
      opts.address ?? `addr-${id}`,
      opts.isPrimary ?? 0,
      opts.externalChatId ?? null,
      100,
    );
}

type ContactRow = {
  display_name: string;
  notes: string | null;
  user_file: string | null;
  contact_type: string;
};

function contactRow(id: string): ContactRow | null {
  return (
    (getSqlite()
      .prepare(
        "SELECT display_name, notes, user_file, contact_type FROM contacts WHERE id = ?",
      )
      .get(id) as ContactRow | undefined) ?? null
  );
}

type ChannelRow = {
  id: string;
  contact_id: string;
  is_primary: number;
  external_chat_id: string | null;
};

function channelByAddress(type: string, address: string): ChannelRow | null {
  return (
    (getSqlite()
      .prepare(
        "SELECT id, contact_id, is_primary, external_chat_id FROM contact_channels WHERE type = ? AND address = ? COLLATE NOCASE",
      )
      .get(type, address) as ChannelRow | undefined) ?? null
  );
}

function metadataRow(
  contactId: string,
): { species: string; metadata: string | null } | null {
  return (
    (getSqlite()
      .prepare(
        "SELECT species, metadata FROM assistant_contact_metadata WHERE contact_id = ?",
      )
      .get(contactId) as { species: string; metadata: string | null } | undefined) ??
    null
  );
}

function upsertFull(body: Record<string, unknown>): unknown {
  return handleContactsMirrorUpsertFull({ body });
}

describe("contacts_mirror_upsert_full", () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.exec("DELETE FROM assistant_contact_metadata");
    sqlite.exec("DELETE FROM contact_channels");
    sqlite.exec("DELETE FROM contacts");
  });

  // ── Sparse contact update (omit-to-preserve) ──────────────────────────

  test("sparse update touches only provided fields — omitted ones preserved", () => {
    seedContact("co-1", {
      displayName: "Curated Name",
      notes: "old notes",
      userFile: "curated.md",
      contactType: "assistant",
    });

    expect(upsertFull({ contactId: "co-1", notes: "new notes" })).toEqual({
      ok: true,
    });

    expect(contactRow("co-1")).toEqual({
      display_name: "Curated Name",
      notes: "new notes",
      user_file: "curated.md",
      contact_type: "assistant",
    });
  });

  test("displayName-only update preserves notes and never rewrites user_file", () => {
    seedContact("co-1", { notes: "keep me", userFile: "keep.md" });

    upsertFull({ contactId: "co-1", displayName: "Renamed" });

    const row = contactRow("co-1");
    expect(row?.display_name).toBe("Renamed");
    expect(row?.notes).toBe("keep me");
    expect(row?.user_file).toBe("keep.md");
  });

  test("explicit null notes clears them (null ≠ omitted)", () => {
    seedContact("co-1", { notes: "to be cleared" });
    upsertFull({ contactId: "co-1", notes: null });
    expect(contactRow("co-1")?.notes).toBeNull();
  });

  // ── Create path (slug-resolved user_file) ─────────────────────────────

  test("create inserts the full row with a generated user_file slug", () => {
    upsertFull({
      contactId: "co-new",
      displayName: "Alice Smith",
      notes: "n",
    });

    expect(contactRow("co-new")).toEqual({
      display_name: "Alice Smith",
      notes: "n",
      user_file: "alice-smith.md",
      contact_type: "human",
    });
  });

  test("create slug is collision-suffixed against existing user_files", () => {
    seedContact("co-a", { userFile: "alice-smith.md" });
    upsertFull({ contactId: "co-new", displayName: "Alice Smith" });
    expect(contactRow("co-new")?.user_file).toBe("alice-smith-2.md");
  });

  test("create display name falls back to first channel address, then 'Unknown'", () => {
    upsertFull({
      contactId: "co-ch",
      channels: [{ type: "email", address: "a@x.com" }],
    });
    expect(contactRow("co-ch")?.display_name).toBe("a@x.com");

    upsertFull({ contactId: "co-bare" });
    expect(contactRow("co-bare")?.display_name).toBe("Unknown");
  });

  // ── assistant_contact_metadata upsert ─────────────────────────────────

  test("metadata upsert: insert then conflict-update, assistant contactType only", () => {
    upsertFull({
      contactId: "co-bot",
      displayName: "Bot",
      contactType: "assistant",
      assistantMetadata: { species: "vellum", metadata: { assistantId: "a1" } },
    });
    expect(metadataRow("co-bot")).toEqual({
      species: "vellum",
      metadata: JSON.stringify({ assistantId: "a1" }),
    });

    // Second call updates in place (ON CONFLICT DO UPDATE).
    upsertFull({
      contactId: "co-bot",
      contactType: "assistant",
      assistantMetadata: { species: "vellum", metadata: { assistantId: "a2" } },
    });
    expect(metadataRow("co-bot")).toEqual({
      species: "vellum",
      metadata: JSON.stringify({ assistantId: "a2" }),
    });
  });

  test("metadata is gated on contactType 'assistant' — ignored otherwise", () => {
    upsertFull({
      contactId: "co-human",
      displayName: "Human",
      contactType: "human",
      assistantMetadata: { species: "vellum" },
    });
    expect(metadataRow("co-human")).toBeNull();

    // Omitted contactType is not "assistant" either.
    upsertFull({
      contactId: "co-omit",
      displayName: "Omit",
      assistantMetadata: { species: "vellum" },
    });
    expect(metadataRow("co-omit")).toBeNull();
  });

  test("null metadata blob is stored as SQL NULL", () => {
    upsertFull({
      contactId: "co-bot",
      displayName: "Bot",
      contactType: "assistant",
      assistantMetadata: { species: "openclaw", metadata: null },
    });
    expect(metadataRow("co-bot")).toEqual({ species: "openclaw", metadata: null });
  });

  // ── Channel sync ──────────────────────────────────────────────────────

  test("new channel adopts the gateway-minted id; without one a uuid is minted", () => {
    seedContact("co-1");

    upsertFull({
      contactId: "co-1",
      channels: [
        { id: "gw-ch-1", type: "email", address: "adopt@x.com", isPrimary: true },
        { type: "email", address: "minted@x.com" },
      ],
    });

    const adopted = channelByAddress("email", "adopt@x.com");
    expect(adopted?.id).toBe("gw-ch-1");
    expect(adopted?.is_primary).toBe(1);

    const minted = channelByAddress("email", "minted@x.com");
    expect(minted?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(minted?.is_primary).toBe(0);
  });

  test("conflict-skip: an address owned by another contact is never stolen", () => {
    seedContact("co-1");
    seedContact("co-other");
    seedChannel("ch-other", "co-other", {
      type: "email",
      address: "Taken@X.com",
    });

    // Case-insensitive match — the mirror must skip, not reassign or dupe.
    upsertFull({
      contactId: "co-1",
      channels: [{ id: "gw-new", type: "email", address: "taken@x.com" }],
    });

    const row = channelByAddress("email", "taken@x.com");
    expect(row?.id).toBe("ch-other");
    expect(row?.contact_id).toBe("co-other");
  });

  test("existing channel: external_chat_id is omit-to-preserve, explicit null clears", () => {
    seedContact("co-1");
    seedChannel("ch-1", "co-1", {
      type: "telegram",
      address: "tg-1",
      externalChatId: "chat-9",
    });

    // Omitted → preserved.
    upsertFull({
      contactId: "co-1",
      channels: [{ type: "telegram", address: "tg-1" }],
    });
    expect(channelByAddress("telegram", "tg-1")?.external_chat_id).toBe("chat-9");

    // Provided → overwritten.
    upsertFull({
      contactId: "co-1",
      channels: [{ type: "telegram", address: "tg-1", externalChatId: "chat-10" }],
    });
    expect(channelByAddress("telegram", "tg-1")?.external_chat_id).toBe("chat-10");

    // Explicit null → cleared.
    upsertFull({
      contactId: "co-1",
      channels: [{ type: "telegram", address: "tg-1", externalChatId: null }],
    });
    expect(channelByAddress("telegram", "tg-1")?.external_chat_id).toBeNull();
  });

  test("existing channel: is_primary is never rewritten (raw dual-write parity)", () => {
    seedContact("co-1");
    seedChannel("ch-1", "co-1", {
      type: "email",
      address: "p@x.com",
      isPrimary: 1,
    });

    upsertFull({
      contactId: "co-1",
      channels: [{ type: "email", address: "p@x.com", isPrimary: false }],
    });

    expect(channelByAddress("email", "p@x.com")?.is_primary).toBe(1);
  });

  // ── Validation + atomicity ────────────────────────────────────────────

  test("rejects a body missing contactId", () => {
    expect(() => upsertFull({ displayName: "No Id" })).toThrow();
  });

  test("rolls back the WHOLE upsert when a late channel step fails", () => {
    seedContact("co-1", { displayName: "Before" });
    seedContact("co-other");
    // A row already holding the gateway id under a DIFFERENT (type, address):
    // the INSERT collides on the primary key and must abort the transaction.
    seedChannel("gw-dup", "co-other", { type: "slack", address: "elsewhere" });

    expect(() =>
      upsertFull({
        contactId: "co-1",
        displayName: "After",
        channels: [{ id: "gw-dup", type: "email", address: "fresh@x.com" }],
      }),
    ).toThrow();

    // Nothing applied — the contact rename rolled back with the channel.
    expect(contactRow("co-1")?.display_name).toBe("Before");
    expect(channelByAddress("email", "fresh@x.com")).toBeNull();
  });
});

/**
 * Unit tests for the daemon-side contact INFO-READ IPC handlers
 * (ipc/routes/contacts-info-ipc-routes.ts). Each handler reads the real
 * (isolated) assistant DB, so we seed rows via getSqlite() and invoke the
 * handler with `{ body }` exactly as the IPC server would.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  handleContactChannelIdentityLookup,
  handleContactMirrorProbe,
  handleContactsInfoBatch,
  handleContactUserFileSlugs,
} from "../routes/contacts-info-ipc-routes.js";

await initializeDb();

function resetTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM assistant_contact_metadata");
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function insertContact(params: {
  id: string;
  displayName?: string;
  notes?: string | null;
  userFile?: string | null;
  contactType?: "human" | "assistant";
}): void {
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO contacts (id, display_name, notes, user_file, contact_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      params.id,
      params.displayName ?? `name-${params.id}`,
      params.notes ?? null,
      params.userFile ?? null,
      params.contactType ?? "human",
      now,
      now,
    ],
  );
}

function insertChannel(params: {
  id: string;
  contactId: string;
  type?: string;
  address: string;
  externalChatId?: string | null;
}): void {
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    [
      params.id,
      params.contactId,
      params.type ?? "telegram",
      params.address,
      params.externalChatId ?? null,
      now,
      now,
    ],
  );
}

function insertMetadata(params: {
  contactId: string;
  species: string;
  metadata?: Record<string, unknown> | null;
}): void {
  getSqlite().run(
    "INSERT INTO assistant_contact_metadata (contact_id, species, metadata) VALUES (?, ?, ?)",
    [
      params.contactId,
      params.species,
      params.metadata != null ? JSON.stringify(params.metadata) : null,
    ],
  );
}

beforeEach(() => {
  resetTables();
});

// ── contacts_info_batch ──────────────────────────────────────────────────────

describe("handleContactsInfoBatch", () => {
  test("empty contactIds returns empty infos", () => {
    const result = handleContactsInfoBatch({ body: { contactIds: [] } });
    expect(result).toEqual({ infos: [] });
  });

  test("returns info fields and gates assistant metadata on contactType", () => {
    insertContact({ id: "c1", notes: "friend", contactType: "human" });
    insertContact({ id: "c2", contactType: "assistant" });
    insertMetadata({ contactId: "c2", species: "vellum", metadata: { model: "opus" } });

    const result = handleContactsInfoBatch({
      body: { contactIds: ["c1", "c2", "missing"] },
    }) as { infos: Array<Record<string, unknown>> };

    expect(result.infos).toHaveLength(2);
    const c1 = result.infos.find((i) => i.contactId === "c1")!;
    expect(c1.notes).toBe("friend");
    expect(c1.contactType).toBe("human");
    expect(c1.assistantMetadata).toBeNull();

    const c2 = result.infos.find((i) => i.contactId === "c2")!;
    expect(c2.contactType).toBe("assistant");
    expect(c2.assistantMetadata).toEqual({
      species: "vellum",
      metadata: { model: "opus" },
    });
  });

  test("does not emit metadata for human contact with stale species row", () => {
    insertContact({ id: "c1", contactType: "human" });
    insertMetadata({ contactId: "c1", species: "vellum", metadata: { x: 1 } });

    const result = handleContactsInfoBatch({
      body: { contactIds: ["c1"] },
    }) as { infos: Array<Record<string, unknown>> };
    expect(result.infos[0].assistantMetadata).toBeNull();
  });

  test("malformed metadata JSON degrades to null metadata", () => {
    insertContact({ id: "c1", contactType: "assistant" });
    getSqlite().run(
      "INSERT INTO assistant_contact_metadata (contact_id, species, metadata) VALUES (?, ?, ?)",
      ["c1", "vellum", "{not valid json"],
    );

    const result = handleContactsInfoBatch({
      body: { contactIds: ["c1"] },
    }) as { infos: Array<Record<string, unknown>> };
    expect(result.infos[0].assistantMetadata).toEqual({
      species: "vellum",
      metadata: null,
    });
  });

  test("rejects a malformed body (non-array contactIds)", () => {
    expect(() =>
      handleContactsInfoBatch({ body: { contactIds: "nope" } as never }),
    ).toThrow();
  });
});

// ── contact_channel_identity_lookup ──────────────────────────────────────────

describe("handleContactChannelIdentityLookup", () => {
  test("resolves by (type, address) case-insensitively", () => {
    insertContact({ id: "c1", displayName: "Alice" });
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "email",
      address: "Alice@Example.com",
      externalChatId: "chat-1",
    });

    const result = handleContactChannelIdentityLookup({
      body: { type: "email", address: "alice@example.com" },
    }) as { channel: Record<string, unknown> | null };

    expect(result.channel).toEqual({
      id: "ch1",
      contactId: "c1",
      type: "email",
      address: "Alice@Example.com",
      externalChatId: "chat-1",
      displayName: "Alice",
    });
  });

  test("resolves by channelId", () => {
    insertContact({ id: "c1", displayName: "Bob" });
    insertChannel({ id: "ch1", contactId: "c1", type: "slack", address: "U123" });

    const result = handleContactChannelIdentityLookup({
      body: { channelId: "ch1" },
    }) as { channel: Record<string, unknown> | null };
    expect(result.channel?.type).toBe("slack");
    expect(result.channel?.address).toBe("U123");
    expect(result.channel?.displayName).toBe("Bob");
  });

  test("returns null when no channel matches", () => {
    const result = handleContactChannelIdentityLookup({
      body: { channelId: "nope" },
    });
    expect(result).toEqual({ channel: null });
  });

  test("rejects a selector with neither channelId nor (type,address)", () => {
    expect(() =>
      handleContactChannelIdentityLookup({ body: { type: "email" } }),
    ).toThrow();
  });
});

// ── contact_mirror_probe ─────────────────────────────────────────────────────

describe("handleContactMirrorProbe", () => {
  test("reports absence when the contact is not mirrored", () => {
    const result = handleContactMirrorProbe({ body: { contactId: "gone" } });
    expect(result).toEqual({
      exists: false,
      hasChannels: false,
      notes: null,
      userFile: null,
      contactType: null,
      hasMetadata: false,
    });
  });

  test("reports info fields, channels, and metadata presence", () => {
    insertContact({
      id: "c1",
      notes: "note",
      userFile: "alice.md",
      contactType: "assistant",
    });
    insertChannel({ id: "ch1", contactId: "c1", address: "addr" });
    insertMetadata({ contactId: "c1", species: "vellum" });

    const result = handleContactMirrorProbe({
      body: { contactId: "c1" },
    }) as Record<string, unknown>;
    expect(result).toEqual({
      exists: true,
      hasChannels: true,
      notes: "note",
      userFile: "alice.md",
      contactType: "assistant",
      hasMetadata: true,
    });
  });

  test("row present with no channels or metadata (bare seed contact)", () => {
    insertContact({ id: "c1", contactType: "human" });
    const result = handleContactMirrorProbe({
      body: { contactId: "c1" },
    }) as Record<string, unknown>;
    expect(result.exists).toBe(true);
    expect(result.hasChannels).toBe(false);
    expect(result.hasMetadata).toBe(false);
    expect(result.contactType).toBe("human");
  });
});

// ── contact_user_file_slugs ──────────────────────────────────────────────────

describe("handleContactUserFileSlugs", () => {
  test("lists user_file slugs matching the prefix", () => {
    insertContact({ id: "c1", userFile: "alice.md" });
    insertContact({ id: "c2", userFile: "alice-2.md" });
    insertContact({ id: "c3", userFile: "bob.md" });
    insertContact({ id: "c4", userFile: null });

    const result = handleContactUserFileSlugs({
      body: { prefix: "alice" },
    }) as { userFiles: string[] };
    expect(result.userFiles.sort()).toEqual(["alice-2.md", "alice.md"]);
  });

  test("returns empty list when nothing matches", () => {
    insertContact({ id: "c1", userFile: "zed.md" });
    const result = handleContactUserFileSlugs({ body: { prefix: "alice" } });
    expect(result).toEqual({ userFiles: [] });
  });
});

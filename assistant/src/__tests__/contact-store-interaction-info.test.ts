/**
 * INFO telemetry (interactionCount/lastInteraction/lastSeenAt) is local, not
 * ACL: the gateway's handle-inbound mirror writes it to the assistant DB, and
 * model-facing turn context reads it back. These tests assert the daemon-native
 * read paths (getContact / searchContacts) re-hydrate and aggregate it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  findContactInfoById,
  getContact,
  searchContacts,
} from "../contacts/contact-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function insertContact(id: string, displayName: string): void {
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO contacts (id, display_name, contact_type, user_file, created_at, updated_at) VALUES (?, ?, 'human', ?, ?, ?)",
    [id, displayName, `${id}.md`, now, now],
  );
}

function insertChannel(params: {
  id: string;
  contactId: string;
  type: string;
  address: string;
  interactionCount: number;
  lastInteraction: number | null;
  lastSeenAt?: number | null;
}): void {
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, interaction_count, last_interaction, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
    [
      params.id,
      params.contactId,
      params.type,
      params.address,
      params.interactionCount,
      params.lastInteraction,
      params.lastSeenAt ?? null,
      now,
      now,
    ],
  );
}

describe("contact interaction INFO aggregation", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("getContact sums interaction_count and takes the latest last_interaction across channels", () => {
    insertContact("ct_1", "Alice");
    insertChannel({
      id: "ch_a",
      contactId: "ct_1",
      type: "phone",
      address: "+15550100",
      interactionCount: 3,
      lastInteraction: 1900,
      lastSeenAt: 1850,
    });
    insertChannel({
      id: "ch_b",
      contactId: "ct_1",
      type: "email",
      address: "alice@example.com",
      interactionCount: 4,
      lastInteraction: 2100,
      lastSeenAt: 2050,
    });

    const contact = getContact("ct_1");
    expect(contact).not.toBeNull();
    expect(contact!.interactionCount).toBe(7);
    expect(contact!.lastInteraction).toBe(2100);

    // Per-channel INFO is hydrated too.
    const phone = contact!.channels.find((c) => c.type === "phone");
    expect(phone?.interactionCount).toBe(3);
    expect(phone?.lastInteraction).toBe(1900);
    expect(phone?.lastSeenAt).toBe(1850);
  });

  test("findContactInfoById returns the notes-only INFO shape (telemetry is gateway-owned)", () => {
    insertContact("ct_2", "Bob");
    insertChannel({
      id: "ch_c",
      contactId: "ct_2",
      type: "phone",
      address: "+15550200",
      interactionCount: 5,
      lastInteraction: 1000,
    });

    const info = findContactInfoById("ct_2");
    // Interaction telemetry is no longer surfaced here — it is gateway-owned
    // (carried on the trust verdict / gateway rich reads).
    expect(info).not.toBeNull();
    expect(Object.keys(info!)).toEqual(["notes"]);
    expect(info!.notes).toBeNull();
  });

  test("lastInteraction is null when no channel has interacted", () => {
    insertContact("ct_3", "Carol");
    insertChannel({
      id: "ch_d",
      contactId: "ct_3",
      type: "phone",
      address: "+15550300",
      interactionCount: 0,
      lastInteraction: null,
    });

    const contact = getContact("ct_3");
    expect(contact!.interactionCount).toBe(0);
    expect(contact!.lastInteraction).toBeNull();
  });

  test("filtered searchContacts carries channel INFO fields", () => {
    insertContact("ct_4", "Dana");
    insertChannel({
      id: "ch_e",
      contactId: "ct_4",
      type: "phone",
      address: "+15550400",
      interactionCount: 9,
      lastInteraction: 3000,
      lastSeenAt: 2900,
    });

    const results = searchContacts({ query: "Dana", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].interactionCount).toBe(9);
    expect(results[0].lastInteraction).toBe(3000);
    const ch = results[0].channels[0];
    expect(ch.interactionCount).toBe(9);
    expect(ch.lastSeenAt).toBe(2900);
  });
});

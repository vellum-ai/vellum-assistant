/**
 * Interaction telemetry (interactionCount/lastInteraction/lastSeenAt) is
 * gateway-owned: reads source it from the stamped trust verdict and the gateway
 * rich-read relay, and the assistant DB no longer carries the columns. These
 * tests assert the daemon-native read paths (getContact / searchContacts /
 * findContactInfoById) surface no telemetry.
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
}): void {
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [params.id, params.contactId, params.type, params.address, now, now],
  );
}

const TELEMETRY_KEYS = ["interactionCount", "lastInteraction", "lastSeenAt"];

describe("contact-store surfaces no interaction telemetry", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("getContact returns no telemetry fields on the contact or its channels", () => {
    insertContact("ct_1", "Alice");
    insertChannel({
      id: "ch_a",
      contactId: "ct_1",
      type: "phone",
      address: "+15550100",
    });

    const contact = getContact("ct_1");
    expect(contact).not.toBeNull();
    for (const key of TELEMETRY_KEYS) {
      expect(key in contact!).toBe(false);
    }
    const phone = contact!.channels.find((c) => c.type === "phone")!;
    for (const key of TELEMETRY_KEYS) {
      expect(key in phone).toBe(false);
    }
  });

  test("findContactInfoById returns the notes-only INFO shape (telemetry is gateway-owned)", () => {
    insertContact("ct_2", "Bob");
    insertChannel({
      id: "ch_c",
      contactId: "ct_2",
      type: "phone",
      address: "+15550200",
    });

    const info = findContactInfoById("ct_2");
    expect(info).not.toBeNull();
    expect(Object.keys(info!)).toEqual(["notes"]);
    expect(info!.notes).toBeNull();
  });

  test("filtered searchContacts carries no telemetry fields", () => {
    insertContact("ct_4", "Dana");
    insertChannel({
      id: "ch_e",
      contactId: "ct_4",
      type: "phone",
      address: "+15550400",
    });

    const results = searchContacts({ query: "Dana", limit: 10 });
    expect(results).toHaveLength(1);
    for (const key of TELEMETRY_KEYS) {
      expect(key in results[0]).toBe(false);
      expect(key in results[0].channels[0]).toBe(false);
    }
  });
});

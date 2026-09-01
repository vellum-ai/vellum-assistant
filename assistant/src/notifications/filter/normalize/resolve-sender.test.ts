/**
 * Sender resolution against the real contact store: canonicalization belongs to
 * `findContactChannel`, so these tests feed it raw addresses rather than
 * pre-normalized ones.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { upsertContact } from "../../../contacts/contact-store.js";
import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { attachContactId, resolveSenderContactId } from "./resolve-sender.js";

await initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

describe("resolveSenderContactId", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("resolves a known email channel to its contact id", () => {
    const contact = upsertContact({
      displayName: "Example User",
      channels: [{ type: "email", address: "user@example.com" }],
    });

    expect(
      resolveSenderContactId("email", { address: "user@example.com" }),
    ).toBe(contact.id);
  });

  test("matches case-insensitively via the store's canonicalization", () => {
    const contact = upsertContact({
      displayName: "Example User",
      channels: [{ type: "email", address: "user@example.com" }],
    });

    expect(
      resolveSenderContactId("email", {
        address: "user@example.com".toUpperCase(),
      }),
    ).toBe(contact.id);
  });

  test("returns null for an unknown address", () => {
    expect(
      resolveSenderContactId("email", { address: "nobody@example.com" }),
    ).toBeNull();
  });

  test("returns null when there is nothing to look up", () => {
    expect(resolveSenderContactId("email", {})).toBeNull();
  });

  test("resolves by external chat id", () => {
    const contact = upsertContact({
      displayName: "Example User",
      channels: [{ type: "slack", address: "U123", externalChatId: "D123" }],
    });

    expect(resolveSenderContactId("slack", { externalChatId: "D123" })).toBe(
      contact.id,
    );
  });

  test("returns null when the contact store throws", () => {
    const sqlite = getSqlite();
    sqlite.run("ALTER TABLE contact_channels RENAME TO contact_channels_probe");
    try {
      expect(
        resolveSenderContactId("email", { address: "user@example.com" }),
      ).toBeNull();
    } finally {
      sqlite.run(
        "ALTER TABLE contact_channels_probe RENAME TO contact_channels",
      );
    }
  });
});

describe("attachContactId", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("fills contactId in on the sender it is given", () => {
    const contact = upsertContact({
      displayName: "Example User",
      channels: [{ type: "email", address: "user@example.com" }],
    });

    expect(
      attachContactId(
        { rawId: "user@example.com", displayName: "Example User" },
        "email",
        { address: "user@example.com" },
      ),
    ).toEqual({
      rawId: "user@example.com",
      displayName: "Example User",
      contactId: contact.id,
    });
  });

  test("leaves contactId null for an unknown sender", () => {
    expect(
      attachContactId({ rawId: "x@example.com", displayName: null }, "email", {
        address: "x@example.com",
      }).contactId,
    ).toBeNull();
  });
});

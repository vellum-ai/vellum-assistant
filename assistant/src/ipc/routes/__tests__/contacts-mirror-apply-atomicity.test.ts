/**
 * Atomicity of the transactional identity-mirror IPC (`contacts_mirror_apply`)
 * against the REAL assistant DB. A mid-batch op failure must roll back the
 * ENTIRE daemon-side transaction so the mirror is never left partially applied.
 *
 * The per-op primitives are defensive and don't throw on well-formed input, so
 * the failure is injected: `deleteContact` is mocked to throw, and an earlier
 * real `upsert_contact` op's write must NOT survive.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getSqlite } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";

// Spread the real module so upsert_contact/upsert_channel run against the real
// DB; only deleteContact throws, simulating a mid-batch failure.
const realContactStore = await import("../../../contacts/contact-store.js");
mock.module("../../../contacts/contact-store.js", () => ({
  ...realContactStore,
  deleteContact: () => {
    throw new Error("injected mid-batch failure");
  },
}));

const { handleContactsMirrorApply } = await import(
  "../contacts-mirror-ipc-routes.js"
);

await initializeDb();

function contactExists(id: string): boolean {
  return (
    getSqlite().prepare("SELECT 1 FROM contacts WHERE id = ?").get(id) != null
  );
}

describe("contacts_mirror_apply atomicity", () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.exec("DELETE FROM contact_channels");
    sqlite.exec("DELETE FROM contacts");
  });

  test("rolls back the ENTIRE batch when a later op throws mid-transaction", () => {
    expect(() =>
      handleContactsMirrorApply({
        body: {
          ops: [
            // op1: a real contact write that MUST NOT survive the rollback.
            { op: "upsert_contact", contactId: "rollback-co", displayName: "RB" },
            // op2: throws mid-transaction, aborting the whole batch.
            { op: "delete_contact", contactId: "anything" },
          ],
        },
      }),
    ).toThrow("injected mid-batch failure");

    // op1 rolled back: no partial mirror.
    expect(contactExists("rollback-co")).toBe(false);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";

import { upsertContact } from "../../contacts/contact-store.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { scopedApprovalGrants } from "../../persistence/schema/index.js";
import {
  contactWorkspaceCommandsEnabled,
  disableContactWorkspaceCommands,
  upsertContactToolGrants,
} from "../contact-tool-grant.js";

await initializeDb();

function clearTables(): void {
  getDb().delete(scopedApprovalGrants).run();
  getDb().run("DELETE FROM contact_channels");
  getDb().run("DELETE FROM contacts");
}

function seedContact(id: string, address: string): void {
  upsertContact({
    id,
    displayName: "Alice",
    channels: [{ type: "slack", address }],
  });
}

describe("contact-tool-grant", () => {
  beforeEach(() => clearTables());

  test("upsert is idempotent for the same contact channel", () => {
    seedContact("contact-abc", "U12345678");
    const first = upsertContactToolGrants({
      contactId: "contact-abc",
      requestChannel: "cli",
      decisionChannel: "cli",
    });
    const second = upsertContactToolGrants({
      contactId: "contact-abc",
      requestChannel: "cli",
      decisionChannel: "cli",
    });
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(contactWorkspaceCommandsEnabled("contact-abc")).toBe(true);
  });

  test("disable revokes the standing grant", () => {
    seedContact("contact-abc", "U12345678");
    upsertContactToolGrants({
      contactId: "contact-abc",
      requestChannel: "http",
      decisionChannel: "http",
    });
    expect(disableContactWorkspaceCommands("contact-abc")).toBe(1);
    expect(contactWorkspaceCommandsEnabled("contact-abc")).toBe(false);
  });

  test("upsert rejects a contact with no channels", () => {
    upsertContact({
      id: "contact-abc",
      displayName: "Alice",
    });
    expect(() =>
      upsertContactToolGrants({
        contactId: "contact-abc",
        requestChannel: "cli",
        decisionChannel: "cli",
      }),
    ).toThrow("no channel addresses");
  });
});

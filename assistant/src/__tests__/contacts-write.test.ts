/**
 * Tests for `contacts-write.ts` — specifically the side-effect that
 * seeds `users/<slug>.md` whenever a contact's `userFile` is persisted.
 *
 * These tests use the real DB (via `initializeDb()`) and the real
 * `ensureGuardianPersonaFile` helper. The test preload sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory, so all filesystem
 * writes land under that temp dir and are cleaned up automatically.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
await initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function channelOwnerById(channelId: string): string | undefined {
  const row = getSqlite()
    .query("SELECT contact_id AS contactId FROM contact_channels WHERE id = ?")
    .get(channelId) as { contactId?: string } | undefined;
  return row?.contactId;
}

function channelCount(type: string, address: string): number {
  const row = getSqlite()
    .query(
      "SELECT COUNT(*) AS n FROM contact_channels WHERE type = ? AND address = ? COLLATE NOCASE",
    )
    .get(type, address) as { n: number };
  return row.n;
}

function contactExists(contactId: string): boolean {
  // bun:sqlite .get() returns null (not undefined) when no row matches.
  const row = getSqlite()
    .query("SELECT 1 AS one FROM contacts WHERE id = ?")
    .get(contactId) as { one: number } | null;
  return row !== null;
}

/** Contacts parenting zero channels: the guardian-duplicate shape. */
function channelLessContactCount(): number {
  const row = getSqlite()
    .query(
      "SELECT COUNT(*) AS n FROM contacts c WHERE NOT EXISTS (SELECT 1 FROM contact_channels ch WHERE ch.contact_id = c.id)",
    )
    .get() as { n: number };
  return row.n;
}

function workspaceDir(): string {
  const dir = process.env.VELLUM_WORKSPACE_DIR;
  if (!dir) {
    throw new Error(
      "VELLUM_WORKSPACE_DIR should be set by the test preload — aborting",
    );
  }
  return dir;
}

function userFilePath(slug: string): string {
  return join(workspaceDir(), "users", slug);
}

// Invariant: `upsertContactChannel` must not seed `users/<slug>.md`. Seeding
// there fires the users/ directory watcher on every inbound message
// from a new contact and evicts live conversations. Seeding is
// restricted to the guardian-creation path.
describe("guardian persona seeding and trust-cache invariants", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("upsertContactChannel does NOT seed users/<slug>.md for non-guardian contacts", () => {
    // upsertContact assigns a userFile slug to every contact (including
    // non-guardians) via generateUserFileSlug when no principalId/sibling
    // match is found. If upsertContactChannel grows a persona-seeding
    // call, this test will start seeing the file on disk and fail.
    const result = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "Bob",
      externalChatId: "chat-bob",
      displayName: "Bob",
    });

    expect(result).not.toBeNull();
    // Confirm the contact was actually persisted with a userFile slug —
    // otherwise the assertion below would pass trivially.
    expect(result?.contact.userFile).toBeTruthy();

    const slug = result!.contact.userFile!;
    const personaPath = userFilePath(slug);
    expect(existsSync(personaPath)).toBe(false);
  });
});

// The identity mirror must faithfully replicate gateway-owned identity rows:
// same channel id, NULL user_file for mirror-created stubs, and a refreshable
// display name on inbound seeds. It must NOT impose the primitive's
// guardian-curation semantics (generated user_file, preserved name).
describe("identity-mirror faithful-replica semantics", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("Finding A: userFileOnCreate:null leaves a mirror-created contact's user_file NULL", () => {
    const result = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "SeedA",
      externalChatId: "chat-seed-a",
      displayName: "Seed A",
      contactId: "co-seed-a",
      channelId: "gw-ch-a",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    expect(result).not.toBeNull();
    // Mirror stub carries no persona-file pointer, so orphan-GC treats it as
    // unauthored and can reclaim it after a guardian channel claim.
    expect(result?.contact.userFile).toBeNull();
  });

  test("an op carrying the gateway channel id adopts it onto a divergent legacy row", () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UADOPTID",
      displayName: "Alice",
      contactId: "co-adopt-id",
      channelId: "legacy-ch",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    // The gateway's row for the same identity lives under a different UUID;
    // the mirror adopts it so both stores key the channel identically.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UADOPTID",
      displayName: "Alice",
      contactId: "co-adopt-id",
      channelId: "gw-ch-aligned",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    expect(channelOwnerById("gw-ch-aligned")).toBe("co-adopt-id");
    expect(channelOwnerById("legacy-ch")).toBeUndefined();
    expect(channelCount("slack", "UADOPTID")).toBe(1);
  });

  test("Finding B: an explicit (gateway-minted) channel id is reused verbatim", () => {
    const result = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBEE",
      externalChatId: "DBEE",
      displayName: "Bee",
      contactId: "co-bee",
      channelId: "gw-channel-777",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    expect(result?.channel.id).toBe("gw-channel-777");
  });

  test("Finding C: refreshDisplayName refreshes the mirror name on a follow-up seed", () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UCEE",
      externalChatId: "DCEE",
      displayName: "Old Name",
      contactId: "co-cee",
      channelId: "gw-ch-cee",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    const refreshed = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UCEE",
      externalChatId: "DCEE",
      displayName: "New Name",
      contactId: "co-cee",
      refreshDisplayName: true,
    });

    expect(refreshed?.contact.displayName).toBe("New Name");
  });

  test("Finding C: the invite-binding path (no refresh flag) preserves a curated name", () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UDEE",
      externalChatId: "DDEE",
      displayName: "Curated Name",
      contactId: "co-dee",
      channelId: "gw-ch-dee",
      refreshDisplayName: true,
      userFileOnCreate: null,
    });

    // Invite binding re-binds the channel with the raw platform name; the
    // curated contact name must NOT be clobbered.
    const bound = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UDEE",
      externalChatId: "DDEE",
      displayName: "Raw Platform Name",
      contactId: "co-dee",
    });

    expect(bound?.contact.displayName).toBe("Curated Name");
  });
});

// The inbound-seed mirror must match the gateway insert's onConflictDoNothing:
// when a first-seen race lands a second contact for the same (type,address), the
// mirror must NOT reparent the channel to the second contact (that would leave
// the mirror pointing at contact #2 while the gateway ACL row keeps contact #1).
// Only the invite-binding path may reparent.
describe("mirror channel-reparenting race semantics", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("SEED path (reassignConflictingChannels:false) does NOT reparent a conflicting channel", () => {
    // Contact #1 wins the create race — gateway keeps this via onConflictDoNothing.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "URACE",
      externalChatId: "DRACE",
      displayName: "First",
      contactId: "co-race-1",
      channelId: "gw-ch-race-1",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });

    // Contact #2: a second first-seen seed event with a fresh contact id for the
    // SAME (type,address). Seed semantics: must leave the channel with contact #1.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "URACE",
      externalChatId: "DRACE",
      displayName: "Second",
      contactId: "co-race-2",
      channelId: "gw-ch-race-2",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });

    // Ownership never moves without reassign and no duplicate channel is
    // created; the row's id follows the latest gateway-sourced op (id
    // adoption), which is what keeps the two stores' keys aligned.
    expect(channelOwnerById("gw-ch-race-2")).toBe("co-race-1");
    expect(channelOwnerById("gw-ch-race-1")).toBeUndefined();
    expect(channelCount("slack", "URACE")).toBe(1);
    // The losing seed adopts contact #1 rather than minting a channel-less
    // contact under its own id.
    expect(contactExists("co-race-2")).toBe(false);
    expect(channelLessContactCount()).toBe(0);
  });

  test("adoption and re-seen seeds never clobber curated record fields", () => {
    // First-seen bot sender: classification and notes land on CREATE.
    const created = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UCURATED",
      externalChatId: "DCURATED",
      displayName: "Peer Assistant",
      contactId: "co-curated",
      channelId: "gw-ch-curated",
      contactType: "assistant",
      notes: "Automated Slack bot",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    expect(created?.contact.contactType).toBe("assistant");
    expect(created?.contact.notes).toBe("Automated Slack bot");

    // A later seed for the same identity (mirror row present) carries record
    // fields for gap recovery, but they are create-only: the stored
    // classification and notes stand.
    const reseen = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UCURATED",
      contactId: "co-curated",
      displayName: "Peer Assistant",
      contactType: "human",
      notes: "seed-refresh notes that must not land",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    expect(reseen?.contact.contactType).toBe("assistant");
    expect(reseen?.contact.notes).toBe("Automated Slack bot");

    // Adoption (a create-shaped op under a foreign id for the same identity)
    // is equally forbidden from touching the adopted contact's record fields.
    const adopted = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UCURATED",
      contactId: "co-curated-foreign",
      displayName: "Peer Assistant",
      contactType: "human",
      notes: "adoption notes that must not land",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    expect(adopted?.contact.id).toBe("co-curated");
    expect(adopted?.contact.contactType).toBe("assistant");
    expect(adopted?.contact.notes).toBe("Automated Slack bot");
    expect(contactExists("co-curated-foreign")).toBe(false);
  });

  test("explicit-id create over a conflicting channel adopts the owner instead of minting an empty contact", () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UADOPT",
      externalChatId: "DADOPT",
      displayName: "Owner",
      contactId: "co-adopt-owner",
      channelId: "gw-ch-adopt",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });

    // A divergence-shaped write: the gateway hands down a contact id the
    // mirror has never seen, for an identity the mirror already parents.
    const result = upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UADOPT",
      displayName: "Owner Renamed",
      contactId: "co-adopt-foreign",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });

    expect(result?.contact.id).toBe("co-adopt-owner");
    expect(result?.contact.displayName).toBe("Owner Renamed");
    expect(channelOwnerById("gw-ch-adopt")).toBe("co-adopt-owner");
    expect(contactExists("co-adopt-foreign")).toBe(false);
    expect(channelLessContactCount()).toBe(0);
  });

  test("INVITE-binding path (reassignConflictingChannels:true) DOES reparent", () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBIND",
      externalChatId: "DBIND",
      displayName: "Seed Owner",
      contactId: "co-bind-seed",
      channelId: "gw-ch-bind",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });

    // Invite binds the redeemer's existing channel to the invite's target
    // contact — the legitimate reparent.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBIND",
      externalChatId: "DBIND",
      displayName: "Target Contact",
      contactId: "co-bind-target",
      reassignConflictingChannels: true,
    });

    expect(channelOwnerById("gw-ch-bind")).toBe("co-bind-target");
    expect(channelCount("slack", "UBIND")).toBe(1);
  });
});

/**
 * Inbound contact seeding must dedupe against the gateway DB (the source of
 * truth) and never mint a channel-less contact.
 *
 * The defect class under test: a seed that dedupes via the assistant mirror
 * mints a fresh gateway contact whenever the mirror is missing a row for an
 * already-bound address (the guardian's own channel identity included), and
 * the channel insert then no-ops on the (type, address) unique index. The
 * guardian sees themselves as a second, unlinkable contact.
 *
 * The gateway DB is real and file-backed, so the assertions count rows
 * rather than calls. The assistant mirror is reduced to a recorder: the seed
 * path must never read it, and what it sends there is asserted as payload.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

const socketDir = mkdtempSync(join(tmpdir(), "inbound-contact-seed-"));
const socketPath = join(socketDir, "assistant.sock");
// Per-test switch: when false, resolveIpcSocketPath points at a missing file,
// modeling a daemon that is not running.
let socketPresent = true;

mock.module("../ipc/endpoint.js", () => ({
  resolveIpcSocketPath: () => ({
    path: socketPresent ? socketPath : join(socketDir, "absent.sock"),
    source: "test",
  }),
}));

/** Recorded contacts_mirror_* IPC calls, in order. */
const mirrorCalls: { method: string; body: Record<string, unknown> }[] = [];
let mirrorThrow = false;

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: mock(
    async (method: string, params: { body: Record<string, unknown> }) => {
      mirrorCalls.push({ method, body: params.body });
      if (mirrorThrow) {
        throw new Error(`mirror unavailable: ${method}`);
      }
      return {};
    },
  ),
}));

// The seed path must not consult the mirror for dedupe. A throwing stub makes
// any regression to mirror-first dedupe fail loudly rather than pass by
// coincidence. The actual module is spread so unstubbed named exports keep
// resolving when the transitive import graph grows.
const actualContactsInfoClient = await import("../ipc/contacts-info-client.js");
mock.module("../ipc/contacts-info-client.js", () => ({
  ...actualContactsInfoClient,
  lookupContactChannelIdentity: mock(async () => {
    throw new Error(
      "seed path consulted the assistant mirror for dedupe (gateway DB is the source of truth)",
    );
  }),
  probeContactMirror: mock(async () => {
    throw new Error("probeContactMirror not exercised by seeding");
  }),
}));

import { upsertContactChannel } from "../verification/contact-helpers.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

const SLACK_USER = "U06GUARDIAN1";

function allContacts() {
  return getGatewayDb().select().from(contacts).all();
}

function allChannels() {
  return getGatewayDb().select().from(contactChannels).all();
}

/** Contacts parenting zero channels: the guardian-duplicate shape. */
function channelLessContacts() {
  const channelOwners = new Set(allChannels().map((ch) => ch.contactId));
  return allContacts().filter((c) => !channelOwners.has(c.id));
}

const mirrorUpserts = () =>
  mirrorCalls.filter((c) => c.method === "contacts_mirror_upsert_channel");

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  mirrorCalls.length = 0;
  mirrorThrow = false;
  socketPresent = true;
  writeFileSync(socketPath, "");
});

afterAll(() => {
  resetGatewayDb();
});

/** Insert a contact + channel directly, modeling pre-existing gateway state. */
function insertBoundIdentity(opts: {
  contactId: string;
  channelId: string;
  displayName: string;
  role?: string;
  status?: string;
  address?: string;
  externalChatId?: string | null;
}): void {
  const now = Date.now();
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: opts.contactId,
      displayName: opts.displayName,
      role: opts.role ?? "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: opts.channelId,
      contactId: opts.contactId,
      type: "slack",
      address: opts.address ?? SLACK_USER,
      isPrimary: true,
      externalChatId: opts.externalChatId ?? null,
      status: opts.status ?? "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("first-seen seeding", () => {
  test("creates one contact + one unverified channel, ids shared with the mirror", async () => {
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      externalChatId: "D001",
      displayName: "Alice Example",
      username: "alice",
    });

    const rows = allChannels();
    expect(rows).toHaveLength(1);
    expect(allContacts()).toHaveLength(1);
    expect(rows[0].status).toBe("unverified");
    expect(rows[0].policy).toBe("allow");
    // Casing preserved: canonical Slack ids keep their original form.
    expect(rows[0].address).toBe(SLACK_USER);
    expect(rows[0].externalChatId).toBe("D001");
    expect(allContacts()[0].displayName).toBe("Alice Example");

    const op = mirrorUpserts()[0];
    expect(op).toBeTruthy();
    expect(op!.body.contactId).toBe(rows[0].contactId);
    expect(op!.body.channelId).toBe(rows[0].id);
    expect(op!.body.contactType).toBe("human");
    expect(op!.body.refreshDisplayName).toBe(true);
    expect(op!.body.reassignConflictingChannels).toBe(false);
  });

  test("classifies a bot sender as 'assistant' with a provenance note on create only", async () => {
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBOT99",
      displayName: "Peer Assistant",
      contactType: "assistant",
      notes: "Automated Slack bot",
    });
    expect(mirrorUpserts()[0]!.body.contactType).toBe("assistant");
    expect(mirrorUpserts()[0]!.body.notes).toBe("Automated Slack bot");

    // A later seed for the same identity still carries the classification, so
    // a mirror missing the row can recreate it faithfully. The daemon applies
    // these fields on mirror-row CREATE only (create-only semantics pinned in
    // the assistant's contacts-write suite), so guardian edits on an existing
    // mirror record are never clobbered.
    mirrorCalls.length = 0;
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBOT99",
      contactType: "assistant",
      notes: "Automated Slack bot",
    });
    expect(mirrorUpserts()[0]!.body.contactType).toBe("assistant");
    expect(mirrorUpserts()[0]!.body.notes).toBe("Automated Slack bot");
    expect(allContacts()).toHaveLength(1);
  });

  test("gateway write lands even when the assistant socket is absent (mirror skipped)", async () => {
    socketPresent = false;

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      displayName: "Alice Example",
    });

    expect(allChannels()).toHaveLength(1);
    expect(mirrorCalls).toHaveLength(0);
  });
});

describe("re-seen identity", () => {
  test("updates in place: no new rows, delivery chat id persisted, curated gateway name preserved", async () => {
    insertBoundIdentity({
      contactId: "co-1",
      channelId: "ch-1",
      displayName: "Mom",
      status: "unverified",
    });

    // The platform profile says "Alice Example", a DM supplies the chat id.
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      externalChatId: "D-dm",
      displayName: "Alice Example",
    });

    expect(allContacts()).toHaveLength(1);
    const rows = allChannels();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("ch-1");
    expect(rows[0].externalChatId).toBe("D-dm");
    // The gateway name is the guardian-curated one; only the mirror tracks
    // the live platform profile.
    expect(allContacts()[0].displayName).toBe("Mom");
    // The op projects the gateway's owner ids so a mirror gap heals under the
    // same keys.
    const op = mirrorUpserts()[0];
    expect(op!.body.contactId).toBe("co-1");
    expect(op!.body.channelId).toBe("ch-1");
    expect(op!.body.displayName).toBe("Alice Example");
    expect(op!.body.refreshDisplayName).toBe(true);
  });

  test("an omitted delivery chat id preserves the stored one", async () => {
    insertBoundIdentity({
      contactId: "co-1",
      channelId: "ch-1",
      displayName: "Alice",
      externalChatId: "D-kept",
    });

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      displayName: "Alice",
    });

    expect(allChannels()[0].externalChatId).toBe("D-kept");
  });

  test("a revoked channel gets its identity refreshed but stays revoked", async () => {
    insertBoundIdentity({
      contactId: "co-1",
      channelId: "ch-1",
      displayName: "Alice",
      status: "revoked",
      address: "u06guardian1",
    });

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      displayName: "Alice",
    });

    const rows = allChannels();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("revoked");
    // Canonical casing self-heal on the NOCASE-matched row.
    expect(rows[0].address).toBe(SLACK_USER);
  });

  test("a blocked channel short-circuits: no writes, no mirror op", async () => {
    insertBoundIdentity({
      contactId: "co-1",
      channelId: "ch-1",
      displayName: "Blocked Actor",
      status: "blocked",
      externalChatId: null,
    });

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      externalChatId: "D-block",
      displayName: "Blocked Actor",
    });

    expect(allChannels()[0].externalChatId).toBeNull();
    expect(mirrorCalls).toHaveLength(0);
  });
});

describe("guardian duplicate regression", () => {
  test("a mirror gap for a guardian-bound identity mints nothing", async () => {
    // The guardian's Slack identity is bound gateway-side; the assistant
    // mirror knows nothing (the best-effort binding mirror failed). The
    // throwing lookup stub above IS the mirror gap: the seed must not ask.
    insertBoundIdentity({
      contactId: "co-guardian",
      channelId: "ch-guardian",
      displayName: "Boss",
      role: "guardian",
    });

    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: SLACK_USER,
      externalChatId: "D-own-dm",
      displayName: "Alice Example",
    });

    // The counts are the assertion: one contact, one channel, zero
    // channel-less contacts. A mirror-first dedupe seeds a second contact
    // here, carrying the guardian's platform profile name and no channel.
    expect(allContacts()).toHaveLength(1);
    expect(allChannels()).toHaveLength(1);
    expect(channelLessContacts()).toHaveLength(0);
    expect(allContacts()[0].displayName).toBe("Boss");
    // The mirror heal op carries the gateway owner's ids, so the gap is
    // recreated under the same keys; the daemon's channel-identity adoption
    // keeps a divergent mirror from minting an empty contact for them.
    const op = mirrorUpserts()[0];
    expect(op).toBeTruthy();
    expect(op!.body.contactId).toBe("co-guardian");
    expect(op!.body.channelId).toBe("ch-guardian");
  });

  test("a mirror failure never rolls back or duplicates the gateway write", async () => {
    mirrorThrow = true;

    await expect(
      upsertContactChannel({
        sourceChannel: "slack",
        externalUserId: SLACK_USER,
        displayName: "Alice Example",
      }),
    ).rejects.toThrow("mirror unavailable");

    expect(allContacts()).toHaveLength(1);
    expect(allChannels()).toHaveLength(1);
    expect(channelLessContacts()).toHaveLength(0);
  });

  test("a retry after a failed mirror write recovers the mirror faithfully", async () => {
    // First seed of a bot sender: the gateway commit lands, the mirror op is
    // lost.
    mirrorThrow = true;
    await expect(
      upsertContactChannel({
        sourceChannel: "slack",
        externalUserId: "UBOT99",
        displayName: "Peer Assistant",
        contactType: "assistant",
        notes: "Automated Slack bot",
      }),
    ).rejects.toThrow("mirror unavailable");
    const gwRow = allChannels()[0];

    // The next message from the same sender must hand the mirror the SAME
    // gateway ids and the same classification, so the recovered mirror row
    // is not an unrelated human record under divergent keys.
    mirrorThrow = false;
    mirrorCalls.length = 0;
    await upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UBOT99",
      displayName: "Peer Assistant",
      contactType: "assistant",
      notes: "Automated Slack bot",
    });

    expect(allContacts()).toHaveLength(1);
    const op = mirrorUpserts()[0];
    expect(op!.body.contactId).toBe(gwRow.contactId);
    expect(op!.body.channelId).toBe(gwRow.id);
    expect(op!.body.contactType).toBe("assistant");
    expect(op!.body.notes).toBe("Automated Slack bot");
  });
});

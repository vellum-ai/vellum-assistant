/**
 * Discord verification must UPGRADE the contact row inbound seeding already
 * created, never add a second one.
 *
 * Discord has seeded a contact channel for every actor it sees since the
 * gateway client shipped, so by the time anyone verifies, a row for them
 * already exists. Two rows for one person, one verified and one not, means
 * trust resolution answers differently depending which it reaches first, and
 * the wrong answer is the one that says a verified guardian is a stranger.
 *
 * The gateway DB is real and file-backed, so the assertions can count rows
 * rather than count calls. The assistant mirror is a small in-memory stand-in
 * behind the same two IPC surfaces production uses: seeding writes to it, and
 * verification's identity lookup reads from it. That lookup is the mechanism
 * under test, so faking its result would test nothing.
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

// `upsertContactChannel` skips its work entirely when the assistant IPC socket
// is absent, so point the resolver at a real file to keep the seeding path live.
const socketDir = mkdtempSync(join(tmpdir(), "discord-verify-upgrade-"));
const socketPath = join(socketDir, "assistant.sock");
writeFileSync(socketPath, "");

mock.module("../ipc/endpoint.js", () => ({
  resolveIpcSocketPath: () => ({ path: socketPath, source: "test" }),
}));

/** The assistant identity mirror, keyed the way the daemon keys it. */
type MirrorChannel = {
  id: string;
  contactId: string;
  type: string;
  address: string;
  externalChatId: string | null;
  displayName: string | null;
};
const mirror = new Map<string, MirrorChannel>();
const mirrorKey = (type: string, address: string) =>
  `${type}:${address.toLowerCase()}`;

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: mock(
    async (method: string, params: { body: Record<string, unknown> }) => {
      if (method !== "contacts_mirror_upsert_channel") {
        return {};
      }
      const body = params.body;
      const type = String(body.type);
      const address = String(body.address);
      const key = mirrorKey(type, address);
      const existing = mirror.get(key);
      mirror.set(key, {
        // The mirror adopts the gateway-minted channel id on create and keeps
        // its own on update, which is what makes the second write an update.
        id: existing?.id ?? String(body.channelId ?? crypto.randomUUID()),
        contactId: String(body.contactId),
        type,
        address,
        externalChatId:
          body.externalChatId !== undefined
            ? String(body.externalChatId)
            : (existing?.externalChatId ?? null),
        displayName:
          body.displayName !== undefined
            ? String(body.displayName)
            : (existing?.displayName ?? null),
      });
      return {};
    },
  ),
}));

mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: mock(
    async (selector: { type?: string; address?: string }) =>
      selector.type && selector.address
        ? (mirror.get(mirrorKey(selector.type, selector.address)) ?? null)
        : null,
  ),
  probeContactMirror: mock(async () => ({
    exists: false,
    hasChannels: false,
    notes: null,
    userFile: null,
    contactType: null,
    hasMetadata: false,
  })),
}));

import {
  upsertContactChannel,
  upsertVerifiedContactChannel,
} from "../verification/contact-helpers.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

/** A Discord user snowflake, as the gateway sees it on inbound. */
const DISCORD_USER = "900000000000000042";
/** The public guild channel the actor was first seen in. */
const GUILD_CHANNEL = "800000000000000001";
/** The private DM channel the code is answered in. */
const DM_CHANNEL = "800000000000000099";

function discordChannelRows() {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .filter((row) => row.type === "discord");
}

/**
 * Contact rows, which is where the duplicate actually lands.
 *
 * The channel row is resilient on its own: `writeVerifiedGatewayChannel`
 * falls back to the `(type,address)` unique index, so it updates the seeded
 * channel even when the mirror lookup misses. What it cannot undo is the
 * fresh `contacts` row the create path inserts first. That orphan is the
 * second "row for one person" the guardian sees in the Contacts pane, and it
 * is what these counts are watching.
 */
function contactRows() {
  return getGatewayDb().select().from(contacts).all();
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  mirror.clear();
});

afterAll(() => {
  resetGatewayDb();
});

describe("Discord verification over a seeded contact", () => {
  test("upgrades the seeded row in place and leaves exactly one", async () => {
    // Inbound seeding, as the Discord gateway client does it today: identity
    // only, no delivery address, because a guild channel is not one.
    await upsertContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      displayName: "Alice Example",
      username: "alice",
    });

    const seeded = discordChannelRows();
    expect(seeded).toHaveLength(1);
    expect(contactRows()).toHaveLength(1);
    expect(seeded[0].status).toBe("unverified");
    expect(seeded[0].verifiedAt).toBeNull();
    const seededChannelId = seeded[0].id;
    const seededContactId = seeded[0].contactId;

    // The same person then completes the code handshake in a DM.
    const result = await upsertVerifiedContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      externalChatId: DM_CHANNEL,
      displayName: "Alice Example",
      username: "alice",
      verifiedVia: "challenge",
    });
    expect(result.verified).toBe(true);

    // The counts are the assertion. A second person here is the failure this
    // test exists for, and it would still leave every "is it verified?" check
    // passing on whichever row it happened to read.
    expect(contactRows()).toHaveLength(1);
    expect(contactRows()[0].id).toBe(seededContactId);

    const after = discordChannelRows();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(seededChannelId);
    expect(after[0].contactId).toBe(seededContactId);
    expect(after[0].status).toBe("active");
    expect(after[0].verifiedAt).not.toBeNull();
    expect(after[0].verifiedVia).toBe("challenge");
    // The DM channel becomes the delivery address only now, on verification.
    expect(after[0].externalChatId).toBe(DM_CHANNEL);
  });

  test("a guild-channel seed never records the room as a delivery address", async () => {
    // If a guild channel were stored here, every later private notice
    // addressed to `externalChatId` would be posted to the whole server.
    await upsertContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      displayName: "Alice Example",
    });

    const rows = discordChannelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalChatId).toBeNull();
    expect(rows[0].externalChatId).not.toBe(GUILD_CHANNEL);
  });

  test("verifying without a prior seed still produces one row", async () => {
    // The install that verifies before ever being messaged. The upgrade path
    // must not be the only path that keeps the count at one.
    const result = await upsertVerifiedContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      externalChatId: DM_CHANNEL,
      displayName: "Alice Example",
      verifiedVia: "challenge",
    });
    expect(result.verified).toBe(true);

    const rows = discordChannelRows();
    expect(rows).toHaveLength(1);
    expect(contactRows()).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  test("a seed arriving after verification does not downgrade or duplicate", async () => {
    await upsertVerifiedContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      externalChatId: DM_CHANNEL,
      displayName: "Alice Example",
      verifiedVia: "challenge",
    });

    // The verified guardian goes on talking in the guild, which seeds again.
    await upsertContactChannel({
      sourceChannel: "discord",
      externalUserId: DISCORD_USER,
      displayName: "Alice Example",
    });

    const rows = discordChannelRows();
    expect(rows).toHaveLength(1);
    expect(contactRows()).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].verifiedAt).not.toBeNull();
    // The seed carries no delivery address, and must not blank the one
    // verification established.
    expect(rows[0].externalChatId).toBe(DM_CHANNEL);
  });
});

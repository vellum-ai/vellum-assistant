/**
 * Tests for the pull-based contact-mirror reconciler.
 *
 * The reconciler converges the assistant identity mirror onto the gateway's
 * identity snapshot: it must heal missing rows under the gateway's own ids,
 * hand a divergent channel to the contact the gateway says owns it, and
 * write NOTHING else. Assistant-authored data (notes, classification,
 * curated names) and mirror-only rows (a2a peers) are exactly what a pull
 * from the gateway cannot reconstruct, so preserving them is as load-bearing
 * as the healing.
 *
 * The daemon DB is real; the gateway snapshot arrives through a mocked
 * `ipcCallPersistent`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContactsIdentitySnapshotIpcResponse } from "@vellumai/gateway-client/gateway-ipc-contracts";

let snapshot: ContactsIdentitySnapshotIpcResponse = { ok: true, contacts: [] };
const ipcCallPersistentMock = mock(async (method: string) => {
  if (method !== "contacts_identity_snapshot") {
    throw new Error(`unexpected IPC method: ${method}`);
  }
  return snapshot;
});
mock.module("../../ipc/gateway-client.js", () => ({
  ipcCallPersistent: ipcCallPersistentMock,
}));

import { getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { deleteContact, upsertContact } from "../contact-store.js";
import { upsertContactChannel } from "../contacts-write.js";
import { runMirrorReconcile } from "../mirror-reconciler.js";
await initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

function contactRow(
  id: string,
): { displayName: string; notes: string | null } | null {
  return getSqlite()
    .query(
      "SELECT display_name AS displayName, notes FROM contacts WHERE id = ?",
    )
    .get(id) as { displayName: string; notes: string | null } | null;
}

function channelRow(
  type: string,
  address: string,
): { id: string; contactId: string; externalChatId: string | null } | null {
  return getSqlite()
    .query(
      "SELECT id, contact_id AS contactId, external_chat_id AS externalChatId FROM contact_channels WHERE type = ? AND address = ? COLLATE NOCASE",
    )
    .get(type, address) as {
    id: string;
    contactId: string;
    externalChatId: string | null;
  } | null;
}

function gatewayContact(opts: {
  id: string;
  displayName: string;
  channels?: Array<{
    id: string;
    type: string;
    address: string;
    externalChatId?: string | null;
    isPrimary?: boolean;
  }>;
}): ContactsIdentitySnapshotIpcResponse["contacts"][number] {
  return {
    id: opts.id,
    displayName: opts.displayName,
    channels: (opts.channels ?? []).map((ch) => ({
      id: ch.id,
      contactId: opts.id,
      type: ch.type,
      address: ch.address,
      externalChatId: ch.externalChatId ?? null,
      isPrimary: ch.isPrimary ?? false,
    })),
  };
}

beforeEach(() => {
  resetContactTables();
  snapshot = { ok: true, contacts: [] };
  ipcCallPersistentMock.mockClear();
});

describe("healing toward the gateway snapshot", () => {
  test("recreates a missing contact + channel under the gateway ids", async () => {
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-gw",
          displayName: "Alice Example",
          channels: [
            {
              id: "ch-gw",
              type: "slack",
              address: "U123",
              externalChatId: "D123",
            },
          ],
        }),
      ],
    };

    await runMirrorReconcile();

    expect(channelRow("slack", "U123")).toEqual({
      id: "ch-gw",
      contactId: "co-gw",
      externalChatId: "D123",
    });
    expect(contactRow("co-gw")?.displayName).toBe("Alice Example");
  });

  test("hands a divergent channel to the contact the gateway says owns it", async () => {
    // The mirror believes the channel belongs to a stale owner.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
      displayName: "Stale Owner",
      contactId: "co-stale",
      channelId: "ch-stale",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-truth",
          displayName: "Alice Example",
          channels: [{ id: "ch-gw", type: "slack", address: "U123" }],
        }),
      ],
    };

    await runMirrorReconcile();

    expect(channelRow("slack", "U123")?.contactId).toBe("co-truth");
    // The heal adopts the gateway id in the same write.
    expect(channelRow("slack", "U123")?.id).toBe("ch-gw");
  });

  test("adopts the gateway channel id onto a same-owner legacy row, then reaches a fixed point", async () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
      displayName: "Alice Example",
      contactId: "co-1",
      channelId: "legacy-ch",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-1",
          displayName: "Alice Example",
          channels: [{ id: "ch-gw", type: "slack", address: "U123" }],
        }),
      ],
    };

    await runMirrorReconcile();
    expect(channelRow("slack", "U123")?.id).toBe("ch-gw");

    // Converged: a follow-up pass writes nothing.
    const before = getSqlite()
      .query("SELECT updated_at AS u FROM contact_channels WHERE id = 'ch-gw'")
      .get() as { u: number };
    await runMirrorReconcile();
    const after = getSqlite()
      .query("SELECT updated_at AS u FROM contact_channels WHERE id = 'ch-gw'")
      .get() as { u: number };
    expect(after.u).toBe(before.u);
  });

  test("recreates a channel-less gateway contact as an identity stub", async () => {
    snapshot = {
      ok: true,
      contacts: [gatewayContact({ id: "co-record", displayName: "Mom" })],
    };

    await runMirrorReconcile();

    expect(contactRow("co-record")?.displayName).toBe("Mom");
  });
});

describe("what a pull must never touch", () => {
  test("mirror-only rows and assistant-authored fields survive untouched", async () => {
    // An a2a peer exists only in the mirror; the seed contact carries
    // guardian-authored notes and a curated name.
    upsertContact({
      id: "co-a2a",
      displayName: "Peer Assistant",
      contactType: "assistant",
      channels: [{ type: "a2a", address: "peer-assistant-id" }],
    });
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
      displayName: "Platform Name",
      contactId: "co-known",
      channelId: "ch-known",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    upsertContact({
      id: "co-known",
      displayName: "Curated Name",
      notes: "vip",
    });

    // The gateway snapshot knows co-known (with a different display name,
    // the curated gateway one) and has never heard of the a2a peer.
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-known",
          displayName: "Gateway Curated",
          channels: [{ id: "ch-known", type: "slack", address: "U123" }],
        }),
      ],
    };

    await runMirrorReconcile();

    expect(channelRow("a2a", "peer-assistant-id")?.contactId).toBe("co-a2a");
    expect(contactRow("co-a2a")?.displayName).toBe("Peer Assistant");
    expect(contactRow("co-known")).toEqual({
      displayName: "Curated Name",
      notes: "vip",
    });
  });

  test("a converged mirror takes no writes (fixed point)", async () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
      externalChatId: "D123",
      displayName: "Alice Example",
      contactId: "co-1",
      channelId: "ch-1",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-1",
          displayName: "Gateway Name",
          channels: [
            {
              id: "ch-1",
              type: "slack",
              address: "U123",
              externalChatId: "D123",
            },
          ],
        }),
      ],
    };
    const before = getSqlite()
      .query("SELECT updated_at AS u FROM contact_channels WHERE id = 'ch-1'")
      .get() as { u: number };

    await runMirrorReconcile();

    const after = getSqlite()
      .query("SELECT updated_at AS u FROM contact_channels WHERE id = 'ch-1'")
      .get() as { u: number };
    expect(after.u).toBe(before.u);
    // Display name still the mirror's own (a no-op pass rewrites nothing).
    expect(contactRow("co-1")?.displayName).toBe("Alice Example");
  });

  test("a snapshot pulled before a delete cannot resurrect the deleted contact", async () => {
    // The gateway deleted co-gone (and the explicit mirror delete op landed)
    // while a snapshot still listing it was in flight. Healing from that
    // stale snapshot would bring the ghost back, and the additive contract
    // would then keep it forever.
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "UGONE",
      displayName: "Alice Example",
      contactId: "co-gone",
      channelId: "ch-gone",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    deleteContact("co-gone");
    snapshot = {
      ok: true,
      contacts: [
        gatewayContact({
          id: "co-gone",
          displayName: "Alice Example",
          channels: [{ id: "ch-gone", type: "slack", address: "UGONE" }],
        }),
      ],
    };

    await runMirrorReconcile();

    expect(contactRow("co-gone")).toBeNull();
    expect(channelRow("slack", "UGONE")).toBeNull();
  });

  test("a failed snapshot pull heals nothing and throws nothing", async () => {
    upsertContactChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
      displayName: "Alice Example",
      contactId: "co-1",
      channelId: "ch-1",
      refreshDisplayName: true,
      userFileOnCreate: null,
      reassignConflictingChannels: false,
    });
    ipcCallPersistentMock.mockImplementationOnce(async () => {
      throw new Error("gateway unreachable");
    });

    await runMirrorReconcile();

    expect(channelRow("slack", "U123")?.contactId).toBe("co-1");
  });
});

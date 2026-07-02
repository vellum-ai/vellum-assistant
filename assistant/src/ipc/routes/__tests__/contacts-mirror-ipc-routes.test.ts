/**
 * The gateway-facing contact identity-mirror methods are IPC-only: registered
 * on the assistant IPC server by operationId, and absent from the shared HTTP
 * route set / `get_route_schema`. They write info-only mirror state on top of
 * the `contact-store` primitives; the gateway DB stays the ACL source of truth.
 */

import { describe, expect, mock, test } from "bun:test";

const upsertContactChannelCalls: unknown[] = [];
const upsertContactCalls: unknown[] = [];
const deleteContactCalls: unknown[] = [];

// Spread the real modules so unrelated consumers (contact-routes) keep their
// exports; override only the primitives the handlers delegate to.
const realContactsWrite = await import("../../../contacts/contacts-write.js");
const realContactStore = await import("../../../contacts/contact-store.js");

mock.module("../../../contacts/contacts-write.js", () => ({
  ...realContactsWrite,
  upsertContactChannel: (params: unknown) => {
    upsertContactChannelCalls.push(params);
    return null;
  },
}));

mock.module("../../../contacts/contact-store.js", () => ({
  ...realContactStore,
  upsertContact: (params: unknown) => {
    upsertContactCalls.push(params);
    return { created: true };
  },
  deleteContact: (id: unknown) => {
    deleteContactCalls.push(id);
  },
}));

const {
  CONTACTS_MIRROR_IPC_METHODS,
  handleContactsMirrorUpsertChannel,
  handleContactsMirrorUpsertContact,
  handleContactsMirrorDeleteContact,
} = await import("../contacts-mirror-ipc-routes.js");

const { ROUTES: contactRoutes } = await import(
  "../../../runtime/routes/contact-routes.js"
);
const { routeDefinitionsToIpcMethods } = await import("../route-adapter.js");

const MIRROR_OPERATION_IDS = [
  "contacts_mirror_upsert_channel",
  "contacts_mirror_upsert_contact",
  "contacts_mirror_delete_contact",
] as const;

describe("contact identity-mirror IPC-only methods", () => {
  test("are reachable on the IPC surface by operationId", () => {
    for (const operationId of MIRROR_OPERATION_IDS) {
      expect(typeof CONTACTS_MIRROR_IPC_METHODS[operationId]).toBe("function");
    }
  });

  test("are NOT in the shared contact ROUTES array", () => {
    const sharedIds = new Set(contactRoutes.map((r) => r.operationId));
    for (const operationId of MIRROR_OPERATION_IDS) {
      expect(sharedIds.has(operationId)).toBe(false);
    }
  });

  test("are NOT in the gateway-facing get_route_schema", async () => {
    const ipcMethods = routeDefinitionsToIpcMethods(contactRoutes);
    const meta = ipcMethods.find((r) => r.operationId === "get_route_schema");
    expect(meta).toBeDefined();
    const schema = (await meta!.handler({})) as { operationId: string }[];
    const schemaIds = new Set(schema.map((e) => e.operationId));
    for (const operationId of MIRROR_OPERATION_IDS) {
      expect(schemaIds.has(operationId)).toBe(false);
    }
  });
});

describe("contacts_mirror_upsert_channel", () => {
  test("maps the wire body onto the info-only channel upsert primitive", () => {
    upsertContactChannelCalls.length = 0;
    const result = handleContactsMirrorUpsertChannel({
      body: {
        contactId: "co-1",
        channelId: "ch-1",
        type: "telegram",
        address: "tg-123",
        externalChatId: "chat-9",
        displayName: "Sam",
        contactType: "assistant",
        notes: "bot provenance",
        refreshDisplayName: true,
      },
    });

    expect(result).toEqual({ ok: true });
    expect(upsertContactChannelCalls).toHaveLength(1);
    expect(upsertContactChannelCalls[0]).toEqual({
      sourceChannel: "telegram",
      externalUserId: "tg-123",
      externalChatId: "chat-9",
      displayName: "Sam",
      contactId: "co-1",
      channelId: "ch-1",
      contactType: "assistant",
      notes: "bot provenance",
      refreshDisplayName: true,
      // The mirror never seeds a persona file: a mirror-created contact keeps
      // user_file NULL (faithful replica of the gateway's raw INSERT).
      userFileOnCreate: null,
    });
  });

  test("threads channelId + refreshDisplayName through and forces userFileOnCreate null", () => {
    upsertContactChannelCalls.length = 0;
    handleContactsMirrorUpsertChannel({
      body: {
        contactId: "co-seed",
        channelId: "gw-ch-42",
        type: "slack",
        address: "U777",
        displayName: "Renamed User",
        refreshDisplayName: true,
      },
    });

    const call = upsertContactChannelCalls[0] as Record<string, unknown>;
    // Gateway-minted channel id is reused verbatim (id-alignment).
    expect(call.channelId).toBe("gw-ch-42");
    // Inbound seed refreshes the display name rather than preserving it.
    expect(call.refreshDisplayName).toBe(true);
    // Mirror-created contact keeps user_file NULL.
    expect(call.userFileOnCreate).toBe(null);
  });

  test("defaults refreshDisplayName/channelId to undefined for the invite-binding path", () => {
    upsertContactChannelCalls.length = 0;
    handleContactsMirrorUpsertChannel({
      body: {
        contactId: "co-invite",
        type: "telegram",
        address: "tg-999",
        displayName: "Redeemer Raw Name",
      },
    });

    const call = upsertContactChannelCalls[0] as Record<string, unknown>;
    // No refresh flag → the primitive preserves the curated contact name.
    expect(call.refreshDisplayName).toBeUndefined();
    expect(call.channelId).toBeUndefined();
    // userFileOnCreate is still forced null even on the invite path.
    expect(call.userFileOnCreate).toBe(null);
  });

  test("threads reassignConflictingChannels through to the primitive (seed=false, invite=true)", () => {
    upsertContactChannelCalls.length = 0;
    handleContactsMirrorUpsertChannel({
      body: {
        contactId: "co-seed",
        type: "slack",
        address: "USEED",
        reassignConflictingChannels: false,
      },
    });
    handleContactsMirrorUpsertChannel({
      body: {
        contactId: "co-invite",
        type: "slack",
        address: "UINV",
        reassignConflictingChannels: true,
      },
    });

    const seedCall = upsertContactChannelCalls[0] as Record<string, unknown>;
    const inviteCall = upsertContactChannelCalls[1] as Record<string, unknown>;
    expect(seedCall.reassignConflictingChannels).toBe(false);
    expect(inviteCall.reassignConflictingChannels).toBe(true);
  });

  test("leaves reassignConflictingChannels undefined when the wire omits it (primitive defaults)", () => {
    upsertContactChannelCalls.length = 0;
    handleContactsMirrorUpsertChannel({
      body: { contactId: "co-x", type: "slack", address: "UX" },
    });
    const call = upsertContactChannelCalls[0] as Record<string, unknown>;
    expect(call.reassignConflictingChannels).toBeUndefined();
  });

  test("omits externalChatId when absent (COALESCE-preserving seed update)", () => {
    upsertContactChannelCalls.length = 0;
    handleContactsMirrorUpsertChannel({
      body: { contactId: "co-2", type: "slack", address: "U123" },
    });

    const call = upsertContactChannelCalls[0] as { externalChatId?: unknown };
    expect(call.externalChatId).toBeUndefined();
  });

  test("rejects a body missing the channel type/address", () => {
    expect(() =>
      handleContactsMirrorUpsertChannel({ body: { address: "U123" } }),
    ).toThrow();
  });
});

describe("contacts_mirror_upsert_contact", () => {
  test("upserts an identity/display contact row without seeding a persona file", () => {
    upsertContactCalls.length = 0;
    const result = handleContactsMirrorUpsertContact({
      body: {
        contactId: "co-guardian",
        displayName: "Guardian",
        contactType: "human",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(upsertContactCalls).toHaveLength(1);
    expect(upsertContactCalls[0]).toEqual({
      id: "co-guardian",
      displayName: "Guardian",
      contactType: "human",
      notes: undefined,
      userFile: null,
    });
  });

  test("rejects a body missing contactId/displayName", () => {
    expect(() =>
      handleContactsMirrorUpsertContact({ body: { contactId: "co-1" } }),
    ).toThrow();
  });
});

describe("contacts_mirror_delete_contact", () => {
  test("deletes the mirror contact row by id", () => {
    deleteContactCalls.length = 0;
    const result = handleContactsMirrorDeleteContact({
      body: { contactId: "co-gone" },
    });

    expect(result).toEqual({ ok: true });
    expect(deleteContactCalls).toEqual(["co-gone"]);
  });

  test("rejects a body missing contactId", () => {
    expect(() =>
      handleContactsMirrorDeleteContact({ body: {} }),
    ).toThrow();
  });
});

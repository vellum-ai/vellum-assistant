/**
 * The gateway-facing contact identity-mirror methods are IPC-only: registered
 * on the assistant IPC server by operationId, and absent from the shared HTTP
 * route set / `get_route_schema`. They write info-only mirror state on top of
 * the `contact-store` primitives; the gateway DB stays the ACL source of truth.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const upsertContactChannelCalls: unknown[] = [];
const upsertContactCalls: unknown[] = [];
const upsertContactMirrorFullCalls: unknown[] = [];
const deleteContactCalls: unknown[] = [];
const mergeContactMirrorCalls: unknown[] = [];

// `mock.module` is process-global; every stub below DELEGATES to the real
// implementation unless this file's tests are running, so the mocks cannot
// leak into sibling suites (e.g. the real-DB merge suite's initializeDb()).
let mockActive = false;
beforeAll(() => {
  mockActive = true;
});
afterAll(() => {
  mockActive = false;
});

// Snapshot-spread the real modules BEFORE mock.module patches their namespaces
// in place — delegating through the live namespace would re-enter the mock.
// Spreading also keeps unrelated exports intact for other consumers.
const realContactsWrite = {
  ...(await import("../../../contacts/contacts-write.js")),
};
const realContactStore = {
  ...(await import("../../../contacts/contact-store.js")),
};

mock.module("../../../contacts/contacts-write.js", () => ({
  ...realContactsWrite,
  upsertContactChannel: (
    ...args: Parameters<typeof realContactsWrite.upsertContactChannel>
  ) => {
    if (!mockActive) {return realContactsWrite.upsertContactChannel(...args);}
    upsertContactChannelCalls.push(args[0]);
    return null;
  },
}));

mock.module("../../../contacts/contact-store.js", () => ({
  ...realContactStore,
  upsertContact: (
    ...args: Parameters<typeof realContactStore.upsertContact>
  ) => {
    if (!mockActive) {return realContactStore.upsertContact(...args);}
    upsertContactCalls.push(args[0]);
    return { created: true };
  },
  deleteContact: (
    ...args: Parameters<typeof realContactStore.deleteContact>
  ) => {
    if (!mockActive) {return realContactStore.deleteContact(...args);}
    deleteContactCalls.push(args[0]);
  },
  upsertContactMirrorFull: (
    ...args: Parameters<typeof realContactStore.upsertContactMirrorFull>
  ) => {
    if (!mockActive) {return realContactStore.upsertContactMirrorFull(...args);}
    upsertContactMirrorFullCalls.push(args[0]);
  },
  mergeContactMirror: (
    ...args: Parameters<typeof realContactStore.mergeContactMirror>
  ) => {
    if (!mockActive) {return realContactStore.mergeContactMirror(...args);}
    mergeContactMirrorCalls.push(args[0]);
  },
}));

// The transactional method wraps ops in getDb().transaction(); run the callback
// inline so op dispatch is observable against the mocked primitives above.
const realDbConnection = {
  ...(await import("../../../persistence/db-connection.js")),
};
mock.module("../../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () =>
    mockActive
      ? { transaction: (fn: () => void) => fn() }
      : realDbConnection.getDb(),
}));

const {
  CONTACTS_MIRROR_IPC_METHODS,
  handleContactsMirrorUpsertChannel,
  handleContactsMirrorUpsertContact,
  handleContactsMirrorUpsertFull,
  handleContactsMirrorDeleteContact,
  handleContactsMirrorMergeContact,
  handleContactsMirrorApply,
} = await import("../contacts-mirror-ipc-routes.js");

const { ROUTES: contactRoutes } = await import(
  "../../../runtime/routes/contact-routes.js"
);
const { routeDefinitionsToIpcMethods } = await import("../route-adapter.js");

const MIRROR_OPERATION_IDS = [
  "contacts_mirror_upsert_channel",
  "contacts_mirror_upsert_contact",
  "contacts_mirror_upsert_full",
  "contacts_mirror_delete_contact",
  "contacts_mirror_merge_contact",
  "contacts_mirror_apply",
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

describe("contacts_mirror_upsert_full", () => {
  test("delegates the parsed params to the transactional full-upsert primitive", () => {
    upsertContactMirrorFullCalls.length = 0;
    const result = handleContactsMirrorUpsertFull({
      body: {
        contactId: "co-full",
        contactType: "assistant",
        notes: null,
        assistantMetadata: { species: "vellum", metadata: { assistantId: "a1" } },
        channels: [
          { id: "gw-ch-1", type: "email", address: "a@x.com", isPrimary: true },
        ],
      },
    });

    expect(result).toEqual({ ok: true });
    expect(upsertContactMirrorFullCalls).toEqual([
      {
        contactId: "co-full",
        // displayName omitted → sparse update preserves the mirror's name.
        displayName: undefined,
        contactType: "assistant",
        notes: null,
        assistantMetadata: { species: "vellum", metadata: { assistantId: "a1" } },
        channels: [
          {
            id: "gw-ch-1",
            type: "email",
            address: "a@x.com",
            isPrimary: true,
            externalChatId: undefined,
          },
        ],
      },
    ]);
  });

  test("rejects a body missing contactId", () => {
    expect(() =>
      handleContactsMirrorUpsertFull({ body: { displayName: "X" } }),
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

describe("contacts_mirror_merge_contact", () => {
  test("delegates the parsed params to the transactional merge primitive", () => {
    mergeContactMirrorCalls.length = 0;
    const result = handleContactsMirrorMergeContact({
      body: {
        keepContactId: "co-keep",
        mergeContactId: "co-merge",
        keepDisplayName: "Keeper",
        resolvedUserFile: "keeper.md",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(mergeContactMirrorCalls).toEqual([
      {
        keepContactId: "co-keep",
        mergeContactId: "co-merge",
        keepDisplayName: "Keeper",
        resolvedUserFile: "keeper.md",
      },
    ]);
  });

  test("rejects a self-merge", () => {
    expect(() =>
      handleContactsMirrorMergeContact({
        body: {
          keepContactId: "co-same",
          mergeContactId: "co-same",
          keepDisplayName: "Same",
        },
      }),
    ).toThrow(/must differ/);
  });

  test("rejects a body missing keepDisplayName", () => {
    expect(() =>
      handleContactsMirrorMergeContact({
        body: { keepContactId: "co-keep", mergeContactId: "co-merge" },
      }),
    ).toThrow();
  });
});

describe("contacts_mirror_apply", () => {
  test("dispatches each op to its matching single-row primitive, in order", () => {
    upsertContactCalls.length = 0;
    upsertContactChannelCalls.length = 0;
    deleteContactCalls.length = 0;

    const result = handleContactsMirrorApply({
      body: {
        ops: [
          { op: "upsert_contact", contactId: "co-1", displayName: "One" },
          {
            op: "upsert_channel",
            contactId: "co-1",
            type: "telegram",
            address: "tg-1",
            isPrimary: true,
          },
          { op: "delete_contact", contactId: "co-old" },
        ],
      },
    });

    expect(result).toEqual({ ok: true });
    // Each op reuses the exact single-row primitive semantics.
    expect(upsertContactCalls).toHaveLength(1);
    expect(upsertContactCalls[0]).toEqual({
      id: "co-1",
      displayName: "One",
      contactType: undefined,
      notes: undefined,
      userFile: null,
    });
    expect(upsertContactChannelCalls).toHaveLength(1);
    const chCall = upsertContactChannelCalls[0] as Record<string, unknown>;
    expect(chCall.contactId).toBe("co-1");
    // isPrimary threads through so the guardian mirror keeps its primary flag.
    expect(chCall.isPrimary).toBe(true);
    expect(chCall.userFileOnCreate).toBe(null);
    expect(deleteContactCalls).toEqual(["co-old"]);
  });

  test("rejects an unknown op discriminator", () => {
    expect(() =>
      handleContactsMirrorApply({
        body: { ops: [{ op: "nope", contactId: "co-1" }] },
      }),
    ).toThrow();
  });

  test("rejects an empty ops array", () => {
    expect(() => handleContactsMirrorApply({ body: { ops: [] } })).toThrow();
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the persistence layer the surface helpers read from so tests can seed
// rows without touching SQLite. Swapped per test via the closure below.
let getMessagesImpl: (conversationId: string) => Array<{
  id: string;
  conversationId: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
}> = () => [];

const realCrud = await import("../persistence/conversation-crud.js");

mock.module("../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) => getMessagesImpl(conversationId),
}));

// Import must come AFTER mock.module so the surface module picks up the
// mocked persistence functions.
const { findPersistedSurfaceInfo } =
  await import("../daemon/conversation-surfaces.js");

const CONVERSATION_ID = "conv-persisted-info-1";

/** A guardian requester: sees every row, so no provenance filtering applies. */
const GUARDIAN = { requesterCanAccessMemory: true };
/** An untrusted requester: only non-guardian-provenance rows are visible. */
const UNTRUSTED = { requesterCanAccessMemory: false };

function seedRows(
  rows: Array<{ id: string; content: unknown[]; metadata?: string }>,
): void {
  getMessagesImpl = () =>
    rows.map((r) => ({
      id: r.id,
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content: r.content,
      createdAt: 0,
      metadata: r.metadata ?? null,
    }));
}

describe("findPersistedSurfaceInfo", () => {
  beforeEach(() => {
    getMessagesImpl = () => [];
  });

  test("returns the surfaceType of a persisted ui_surface block", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          { type: "text", text: "pick one" },
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: { options: [] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1", GUARDIAN)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("returns the data of a persisted ui_surface block", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-confirm-1",
            surfaceType: "confirmation",
            data: { message: "Delete it?", confirmLabel: "Delete forever" },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-confirm-1", GUARDIAN)
        ?.data,
    ).toEqual({ message: "Delete it?", confirmLabel: "Delete forever" });
  });

  test("reports no data when the block carries no object data", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dataless-1",
            surfaceType: "choice",
          },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      CONVERSATION_ID,
      "surface-dataless-1",
      GUARDIAN,
    );
    expect(info?.surfaceType).toBe("choice");
    expect(info?.data).toBeUndefined();
  });

  test("returns undefined for an unknown surfaceId", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-choice-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-missing", GUARDIAN),
    ).toBeUndefined();
  });

  test("returns undefined for a conversation with no messages", () => {
    seedRows([]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1", GUARDIAN),
    ).toBeUndefined();
  });

  test("reaches the oldest row when the newer ones carry no surface", () => {
    seedRows([
      {
        id: "msg-oldest",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-oldest-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
      { id: "msg-2", content: [{ type: "text", text: "later" }] },
      { id: "msg-3", content: [{ type: "text", text: "later" }] },
      { id: "msg-4", content: [{ type: "text", text: "later" }] },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-oldest-1", GUARDIAN)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("reports no surfaceType when the block carries no string one", () => {
    seedRows([
      {
        id: "msg-1",
        content: [
          { type: "ui_surface", surfaceId: "surface-typeless-1", data: {} },
        ],
      },
    ]);

    const info = findPersistedSurfaceInfo(
      CONVERSATION_ID,
      "surface-typeless-1",
      GUARDIAN,
    );
    expect(info).toBeDefined();
    expect(info?.surfaceType).toBeUndefined();
  });

  test("returns undefined rather than throwing when the DB read fails", () => {
    getMessagesImpl = () => {
      throw new Error("database is locked");
    };

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-choice-1", GUARDIAN),
    ).toBeUndefined();
  });

  test("hides a guardian-provenance row from an untrusted requester", () => {
    seedRows([
      {
        id: "msg-guardian",
        metadata: JSON.stringify({ provenanceTrustClass: "guardian" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-guardian-1",
            surfaceType: "confirmation",
            data: { confirmLabel: "Wire the money" },
          },
        ],
      },
    ]);

    // The same row the live history filter drops for this actor.
    expect(
      findPersistedSurfaceInfo(
        CONVERSATION_ID,
        "surface-guardian-1",
        UNTRUSTED,
      ),
    ).toBeUndefined();
    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-guardian-1", GUARDIAN)
        ?.data,
    ).toEqual({ confirmLabel: "Wire the money" });
  });

  test("hides a provenance-less row from an untrusted requester", () => {
    seedRows([
      {
        id: "msg-no-metadata",
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-unstamped-1",
            surfaceType: "choice",
            data: {},
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(
        CONVERSATION_ID,
        "surface-unstamped-1",
        UNTRUSTED,
      ),
    ).toBeUndefined();
  });

  test("serves a contact-provenance row to an untrusted requester", () => {
    seedRows([
      {
        id: "msg-contact",
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-contact-1",
            surfaceType: "choice",
            data: { options: [] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-contact-1", UNTRUSTED)
        ?.surfaceType,
    ).toBe("choice");
  });

  test("skips a filtered newer row and serves the visible older one", () => {
    seedRows([
      {
        id: "msg-contact",
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dup-1",
            surfaceType: "choice",
            data: { options: [{ id: "visible" }] },
          },
        ],
      },
      {
        id: "msg-guardian",
        metadata: JSON.stringify({ provenanceTrustClass: "guardian" }),
        content: [
          {
            type: "ui_surface",
            surfaceId: "surface-dup-1",
            surfaceType: "confirmation",
            data: { options: [{ id: "hidden" }] },
          },
        ],
      },
    ]);

    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-dup-1", UNTRUSTED)
        ?.data,
    ).toEqual({ options: [{ id: "visible" }] });
    expect(
      findPersistedSurfaceInfo(CONVERSATION_ID, "surface-dup-1", GUARDIAN)
        ?.data,
    ).toEqual({ options: [{ id: "hidden" }] });
  });
});

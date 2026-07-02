/**
 * Unit tests for the global-search contacts ordering source.
 *
 * Recency ordering for contacts surfaces `contacts.updatedAt`, never the
 * channel-derived `lastInteraction` column. Daemon-native contact search
 * carries no gateway-relayed ContactRead, so `updatedAt` is the deterministic
 * ordering key.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ContactWithChannels } from "../../../contacts/types.js";

let searchContactsResult: ContactWithChannels[] = [];

const searchContactsMock = mock(() => searchContactsResult);

const actualContactStore = await import("../../../contacts/contact-store.js");

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  searchContacts: searchContactsMock,
}));

const { ROUTES } = await import("../global-search-routes.js");

const handler = ROUTES.find((r) => r.operationId === "search_global")!.handler;

function makeContact(
  overrides: Partial<ContactWithChannels>,
): ContactWithChannels {
  return {
    id: "ct_1",
    displayName: "Alice",
    notes: null,
    role: "contact",
    createdAt: 1,
    updatedAt: 1,
    contactType: "human",
    userFile: null,
    channels: [],
    ...overrides,
  };
}

afterEach(() => {
  searchContactsResult = [];
  searchContactsMock.mockClear();
});

describe("global-search contacts recency source", () => {
  test("surfaces contacts.updatedAt as lastInteraction, not the channel column", async () => {
    searchContactsResult = [
      makeContact({
        id: "ct_1",
        displayName: "Alice",
        updatedAt: 5000,
      }),
    ];

    const result = (await handler({
      queryParams: { q: "ali", categories: "contacts" },
    })) as { results: { contacts: { id: string; lastInteraction: number }[] } };

    expect(result.results.contacts).toHaveLength(1);
    expect(result.results.contacts[0].lastInteraction).toBe(5000);
  });

  test("preserves searchContacts ordering deterministically", async () => {
    searchContactsResult = [
      makeContact({ id: "ct_a", displayName: "A", updatedAt: 300 }),
      makeContact({ id: "ct_b", displayName: "B", updatedAt: 200 }),
      makeContact({ id: "ct_c", displayName: "C", updatedAt: 100 }),
    ];

    const result = (await handler({
      queryParams: { q: "x", categories: "contacts" },
    })) as { results: { contacts: { id: string; lastInteraction: number }[] } };

    expect(result.results.contacts.map((c) => c.id)).toEqual([
      "ct_a",
      "ct_b",
      "ct_c",
    ]);
    expect(result.results.contacts.map((c) => c.lastInteraction)).toEqual([
      300, 200, 100,
    ]);
  });
});

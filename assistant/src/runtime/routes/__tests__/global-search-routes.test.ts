/**
 * Unit tests for the global-search contacts ordering source.
 *
 * Recency ordering for contacts surfaces `contacts.updatedAt`, never the
 * channel-derived `lastInteraction` column. Daemon-native contact search
 * carries no gateway-relayed ContactRead, so `updatedAt` is the deterministic
 * ordering key.
 *
 * Also covers the search-query parser: `is:archived` and its synonyms in the
 * `q` string flip the conversation arm to `includeArchived: true`, and the
 * filter token is stripped from the term before any backend is called.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ContactWithChannels } from "../../../contacts/types.js";

let searchContactsResult: ContactWithChannels[] = [];
let searchConversationsCalls: Array<{
  query: string;
  opts?: Record<string, unknown>;
}> = [];
let searchConversationsResult: unknown[] = [];

const searchContactsMock = mock(() => searchContactsResult);
const searchConversationsMock = mock(
  async (query: string, opts?: Record<string, unknown>) => {
    searchConversationsCalls.push({ query, opts });
    return searchConversationsResult;
  },
);

const actualContactStore = await import("../../../contacts/contact-store.js");
const actualConvQueries = await import(
  "../../../persistence/conversation-queries.js"
);

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  searchContacts: searchContactsMock,
}));
mock.module("../../../persistence/conversation-queries.js", () => ({
  ...actualConvQueries,
  searchConversations: searchConversationsMock,
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
  searchConversationsCalls = [];
  searchConversationsResult = [];
  searchConversationsMock.mockClear();
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

describe("global-search q parser", () => {
  test("plain term passes through with includeArchived: false", async () => {
    await handler({
      queryParams: { q: "shema", categories: "conversations" },
    });

    expect(searchConversationsMock).toHaveBeenCalledTimes(1);
    expect(searchConversationsCalls[0]?.query).toBe("shema");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: false,
    });
  });

  test("is:archived in q flips includeArchived: true and is stripped from the term", async () => {
    await handler({
      queryParams: {
        q: "is:archived shema",
        categories: "conversations",
      },
    });

    expect(searchConversationsMock).toHaveBeenCalledTimes(1);
    expect(searchConversationsCalls[0]?.query).toBe("shema");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: true,
    });
  });

  test("is:archived at end of q is also stripped", async () => {
    await handler({
      queryParams: {
        q: "shema is:archived",
        categories: "conversations",
      },
    });

    expect(searchConversationsCalls[0]?.query).toBe("shema");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: true,
    });
  });

  test("is:archived alone produces an empty term and includeArchived: true", async () => {
    await handler({
      queryParams: {
        q: "is:archived",
        categories: "conversations",
      },
    });

    expect(searchConversationsCalls[0]?.query).toBe("");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: true,
    });
  });

  test("archive:yes and archive:true are synonyms for is:archived (case-insensitive)", async () => {
    for (const filter of ["archive:yes", "archive:true", "ARCHIVE:YES", "Archive:True"]) {
      searchConversationsCalls = [];
      searchConversationsMock.mockClear();

      await handler({
        queryParams: {
          q: `${filter} shema`,
          categories: "conversations",
        },
      });

      expect(searchConversationsCalls[0]?.query).toBe("shema");
      expect(searchConversationsCalls[0]?.opts).toMatchObject({
        includeArchived: true,
      });
    }
  });

  test("is:unarchived (and archive:no / archive:false) explicitly set includeArchived: false", async () => {
    for (const filter of ["is:unarchived", "archive:no", "archive:false"]) {
      searchConversationsCalls = [];
      searchConversationsMock.mockClear();

      await handler({
        queryParams: {
          q: `${filter} shema`,
          categories: "conversations",
        },
      });

      expect(searchConversationsCalls[0]?.query).toBe("shema");
      expect(searchConversationsCalls[0]?.opts).toMatchObject({
        includeArchived: false,
      });
    }
  });

  test("unknown filter tokens are left in the term and do not flip the flag", async () => {
    await handler({
      queryParams: {
        q: "is:starred shema",
        categories: "conversations",
      },
    });

    expect(searchConversationsCalls[0]?.query).toBe("is:starred shema");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: false,
    });
  });

  test("multiple filter tokens: known filter is stripped, unknown stays in the term", async () => {
    await handler({
      queryParams: {
        q: "is:archived is:open shema",
        categories: "conversations",
      },
    });

    // `is:open` is unknown — stays in term. `is:archived` is stripped.
    expect(searchConversationsCalls[0]?.query).toBe("is:open shema");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: true,
    });
  });

  test("the cleaned term is forwarded to the conversations backend", async () => {
    // End-to-end: a `q` that mixes the filter with the term is the user-
    // facing contract. The route must not pass the filter through to the
    // backend, because `searchConversations` would then never match.
    await handler({
      queryParams: {
        q: "is:archived flux capacitor",
        categories: "conversations",
      },
    });

    expect(searchConversationsCalls[0]?.query).toBe("flux capacitor");
    expect(searchConversationsCalls[0]?.opts).toMatchObject({
      includeArchived: true,
    });
  });
});

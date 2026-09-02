/**
 * The `assistant-initiated-threads` split: the threads the assistant started
 * on its own (`source = 'assistant_initiated'`, opt-in at creation) become
 * their own sidebar section instead of sitting in Chats.
 *
 * The flag is the whole point of these tests. It is a read-side gate over rows
 * that exist either way, so the off arm must be byte-identical to the behavior
 * that shipped before the section existed — that is what makes the feature
 * reversible without a migration. Both arms are asserted for every claim.
 *
 * The gate module is mocked rather than the flag registry: the registry
 * resolves through workspace override files, and a test that wrote those would
 * be asserting the resolver's behavior rather than this route's.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Avoid spinning up the real event hub for the pinned/groups branches.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

let flagEnabled = false;
mock.module("../../../config/assistant-initiated-threads-gate.js", () => ({
  isAssistantInitiatedThreadsEnabled: () => flagEnabled,
}));

import { projectAssistantMessage } from "../../../persistence/conversation-attention-store.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { createGroup } from "../../../persistence/group-crud.js";
import { rawRun } from "../../../persistence/raw-query.js";
import { conversations } from "../../../persistence/schema/index.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import type { RouteDefinition } from "../types.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const sectionsHandler = findHandler(
  CONVERSATION_LIST_ROUTES,
  "getConversationSections",
);
const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");

interface SectionRow {
  kind: "pinned" | "group" | "channel" | "chats" | "assistant";
  channelId?: string;
  groupId?: string;
  total: number;
  unread: number;
}

function invokeSections(): SectionRow[] {
  return (sectionsHandler({}) as { sections: SectionRow[] }).sections;
}

interface ListResponse {
  conversations: Array<{ id: string; title: string }>;
}

function invokeList(queryParams: Record<string, string> = {}): ListResponse {
  return listHandler({ queryParams }) as ListResponse;
}

function titlesFrom(response: ListResponse): string[] {
  return response.conversations.map((c) => c.title).sort();
}

/**
 * A thread a producer opted into the assistant-initiated section: a
 * standard-type conversation, filed nowhere, stamped
 * `source: 'assistant_initiated'` at creation (ASSISTANT_INITIATED_SOURCE).
 */
function seedAssistantInitiated(title: string): string {
  return createConversation({ title, source: "assistant_initiated" }).id;
}

/**
 * A transactional notification trail - what the guardian request flows and
 * channel deliveries materialize (`source: 'notification'`, see
 * `notifications/conversation-pairing.ts`). Never a member of the section:
 * these belong to the bell and to Chats.
 */
function seedNotificationTrail(title: string): string {
  return createConversation({ title, source: "notification" }).id;
}

function seedUnseen(conversationId: string): void {
  projectAssistantMessage({
    conversationId,
    messageId: `msg-${conversationId}`,
    messageAt: Date.now(),
  });
}

function stampChannel(conversationId: string, channel: string): void {
  rawRun(
    "test:stampChannel",
    "UPDATE conversations SET origin_channel = ? WHERE id = ?",
    channel,
    conversationId,
  );
}

function pin(conversationId: string): void {
  rawRun(
    "test:pinConversation",
    "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
    conversationId,
  );
}

function fileIntoGroup(conversationId: string, groupId: string): void {
  rawRun(
    "test:fileIntoGroup",
    "UPDATE conversations SET group_id = ? WHERE id = ?",
    groupId,
    conversationId,
  );
}

beforeEach(() => {
  flagEnabled = false;
  getDb().delete(conversations).run();
});

// ---------------------------------------------------------------------------
// Flag off — the shipped behavior, unchanged
// ---------------------------------------------------------------------------

describe("assistant-initiated threads — flag off", () => {
  test("emits no assistant section, and the threads stay counted in Chats", () => {
    seedAssistantInitiated("overnight-realization");
    createConversation({ title: "user-thread" });

    const sections = invokeSections();

    expect(sections.some((s) => s.kind === "assistant")).toBe(false);
    expect(sections).toContainEqual({ kind: "chats", total: 2, unread: 0 });
  });

  test("the threads stay listed in the standard list", () => {
    seedAssistantInitiated("overnight-realization");
    createConversation({ title: "user-thread" });

    expect(titlesFrom(invokeList())).toEqual([
      "overnight-realization",
      "user-thread",
    ]);
  });

  test("their unread still counts toward Chats", () => {
    seedUnseen(seedAssistantInitiated("noticed-something"));
    createConversation({ title: "user-thread" });

    expect(invokeSections()).toContainEqual({
      kind: "chats",
      total: 2,
      unread: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Flag on — the split
// ---------------------------------------------------------------------------

describe("assistant-initiated threads — flag on", () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  test("the threads move out of Chats into their own section", () => {
    seedAssistantInitiated("overnight-realization");
    seedAssistantInitiated("noticed-something");
    createConversation({ title: "user-thread" });

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "assistant", total: 2, unread: 0 });
    expect(sections).toContainEqual({ kind: "chats", total: 1, unread: 0 });
  });

  test("the section renders at zero, the way Chats does", () => {
    createConversation({ title: "user-thread" });

    expect(invokeSections()).toContainEqual({
      kind: "assistant",
      total: 0,
      unread: 0,
    });
  });

  test("unread follows the section, and is not double-counted in Chats", () => {
    seedUnseen(seedAssistantInitiated("noticed-something"));
    seedAssistantInitiated("read-already");
    seedUnseen(createConversation({ title: "user-thread" }).id);

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "assistant", total: 2, unread: 1 });
    expect(sections).toContainEqual({ kind: "chats", total: 1, unread: 1 });
  });

  test("the split leaves channel sections alone", () => {
    seedAssistantInitiated("overnight-realization");
    stampChannel(createConversation({ title: "slack-thread" }).id, "slack");

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "assistant", total: 1, unread: 0 });
    expect(sections).toContainEqual({
      kind: "channel",
      channelId: "slack",
      total: 1,
      unread: 0,
    });
  });

  test("groupId=system:assistant lists exactly those threads", () => {
    seedAssistantInitiated("overnight-realization");
    seedAssistantInitiated("noticed-something");
    createConversation({ title: "user-thread" });

    expect(titlesFrom(invokeList({ groupId: "system:assistant" }))).toEqual([
      "noticed-something",
      "overnight-realization",
    ]);
  });

  test("the standard list withholds them, and keeps every NULL-source row", () => {
    // The regression this guards: `NOT (source = '...')` is NULL for the
    // NULL-source rows that make up most of the list, so a naive negation
    // would return an empty list rather than one section fewer.
    seedAssistantInitiated("overnight-realization");
    createConversation({ title: "user-thread" });
    createConversation({ title: "another-user-thread" });

    expect(titlesFrom(invokeList())).toEqual([
      "another-user-thread",
      "user-thread",
    ]);
  });

  test("a list already scoped to the section is not narrowed to nothing", () => {
    // `groupId=system:assistant` selects on the same column the exclusion
    // negates, so applying both would return an empty page for the one caller
    // that actually wants these rows.
    seedAssistantInitiated("overnight-realization");

    expect(titlesFrom(invokeList({ groupId: "system:assistant" }))).toEqual([
      "overnight-realization",
    ]);
  });

  test("a pinned thread belongs to Pinned, not to both", () => {
    // Section membership is single-valued everywhere else in the sidebar, and
    // this section is carved out of the same ungrouped set Chats is, so
    // pinning has to move a thread rather than duplicate it.
    pin(seedAssistantInitiated("pinned-realization"));
    seedAssistantInitiated("ordinary-realization");

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "assistant", total: 1, unread: 0 });
    expect(sections).toContainEqual({ kind: "pinned", total: 1, unread: 0 });
    expect(titlesFrom(invokeList({ groupId: "system:assistant" }))).toEqual([
      "ordinary-realization",
    ]);
  });

  test("transactional notification trails are not members, and stay in Chats", () => {
    // The membership source is opt-in precisely so the flag turning on cannot
    // sweep the historical guardian-request and channel-delivery trails
    // (`source = 'notification'`) into the section: only threads written for
    // the section, from the moment producers start stamping its source, are
    // members.
    seedNotificationTrail("approve-this-call");
    seedAssistantInitiated("overnight-realization");

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "assistant", total: 1, unread: 0 });
    expect(sections).toContainEqual({ kind: "chats", total: 1, unread: 0 });
    expect(titlesFrom(invokeList())).toEqual(["approve-this-call"]);
    expect(titlesFrom(invokeList({ groupId: "system:assistant" }))).toEqual([
      "overnight-realization",
    ]);
  });

  test("a thread filed into a custom group leaves the section and stays listable", () => {
    // The exclusion is the complement of the section, so a thread that moved
    // out of the section must not stay excluded from the list of the group it
    // moved into — otherwise filing one makes it unreachable.
    const group = createGroup("Reading List");
    const filed = seedAssistantInitiated("filed-realization");
    fileIntoGroup(filed, group.id);

    expect(invokeSections()).toContainEqual({
      kind: "assistant",
      total: 0,
      unread: 0,
    });
    expect(titlesFrom(invokeList({ groupId: group.id }))).toEqual([
      "filed-realization",
    ]);
  });

  test("the Archive view keeps archived section threads", () => {
    // Archive asks archiveStatus=archived with no groupId, and the section
    // only ever lists active rows, so the split's exclusion must not reach
    // archived reads or an archived section thread is visible nowhere.
    const archived = seedAssistantInitiated("archived-realization");
    rawRun(
      "test:archive",
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      archived,
    );

    expect(titlesFrom(invokeList({ archiveStatus: "archived" }))).toEqual([
      "archived-realization",
    ]);
  });

  test("the background umbrella is left unnarrowed", () => {
    // A background row carrying the section's own source is addressed by
    // conversation type, and narrowing that bucket by source would drop rows
    // its callers still page through.
    const background = createConversation({
      title: "background-realization",
      conversationType: "background",
      source: "assistant_initiated",
    });

    expect(
      invokeList({ conversationType: "background" }).conversations.map(
        (c) => c.id,
      ),
    ).toContain(background.id);
  });
});

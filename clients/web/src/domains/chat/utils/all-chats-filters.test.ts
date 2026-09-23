import { describe, expect, test } from "bun:test";

import {
  filterFromSearchParams,
  filterAllChats,
  allChatsFilterKey,
  allChatsFilters,
  allChatsSearchFor,
  searchAllChats,
} from "@/domains/chat/utils/all-chats-filters";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";

function conversation(
  conversationId: string,
  fields: Partial<Conversation> = {},
): Conversation {
  return { conversationId, lastMessageAt: 1, ...fields };
}

const GROUPS: ConversationGroup[] = [
  { id: "group-a", name: "Work", sortPosition: 0, isSystemGroup: false },
  { id: "group-b", name: "Home", sortPosition: 1, isSystemGroup: false },
];

const ROWS: Conversation[] = [
  conversation("conv-native", { originChannel: "vellum" }),
  conversation("conv-slack", { originChannel: "slack" }),
  conversation("conv-grouped", { groupId: "group-a" }),
  conversation("conv-done", { archivedAt: 5 }),
  conversation("conv-background", { conversationType: "background" }),
  conversation("conv-scheduled", { conversationType: "scheduled" }),
];

describe("filterAllChats", () => {
  test("hides automated rows from every view but Background", () => {
    expect(
      filterAllChats(ROWS, { kind: "all" }).map((c) => c.conversationId),
    ).toEqual(["conv-native", "conv-slack", "conv-grouped", "conv-done"]);
  });

  test("shows only automated rows under Background", () => {
    expect(
      filterAllChats(ROWS, { kind: "background" }).map((c) => c.conversationId),
    ).toEqual(["conv-background", "conv-scheduled"]);
  });

  test("keeps a surfaced background row in the default view", () => {
    const surfaced = conversation("conv-surfaced", {
      conversationType: "background",
      surfacedAt: 9,
    });
    expect(
      filterAllChats([surfaced], { kind: "all" }).map((c) => c.conversationId),
    ).toEqual(["conv-surfaced"]);
  });

  test("narrows to archived rows under Done", () => {
    expect(
      filterAllChats(ROWS, { kind: "done" }).map((c) => c.conversationId),
    ).toEqual(["conv-done"]);
  });

  test("narrows to one channel and to one group", () => {
    expect(
      filterAllChats(ROWS, { kind: "channel", channelId: "slack" }).map(
        (c) => c.conversationId,
      ),
    ).toEqual(["conv-slack"]);
    expect(
      filterAllChats(ROWS, { kind: "group", groupId: "group-a" }).map(
        (c) => c.conversationId,
      ),
    ).toEqual(["conv-grouped"]);
  });
});

describe("allChatsFilters", () => {
  test("offers All, Done, the external channels, the used groups, then Background", () => {
    expect(allChatsFilters(ROWS, GROUPS).map(allChatsFilterKey)).toEqual([
      "all",
      "done",
      "channel:slack",
      "group:group-a",
      "background",
    ]);
  });

  test("offers no chip for a group nothing is filed into", () => {
    expect(
      allChatsFilters([conversation("conv-1")], GROUPS).map(allChatsFilterKey),
    ).toEqual(["all", "done", "background"]);
  });

  test("offers no chip for a channel only an automated row carries", () => {
    const rows = [
      conversation("conv-run", {
        conversationType: "background",
        originChannel: "slack",
      }),
    ];
    expect(allChatsFilters(rows, GROUPS).map(allChatsFilterKey)).toEqual([
      "all",
      "done",
      "background",
    ]);
  });

  // A deep link can select a view whose chats are all older than the loaded
  // window; without this the chip row would draw with nothing pressed.
  test("offers the selected chip even when no loaded row justifies it", () => {
    expect(
      allChatsFilters([], GROUPS, {
        kind: "channel",
        channelId: "telegram",
      }).map(allChatsFilterKey),
    ).toEqual(["all", "done", "channel:telegram", "background"]);
    expect(
      allChatsFilters([], GROUPS, { kind: "group", groupId: "group-b" }).map(
        allChatsFilterKey,
      ),
    ).toEqual(["all", "done", "group:group-b", "background"]);
  });

  test("does not duplicate a selected chip the rows already justify", () => {
    expect(
      allChatsFilters(ROWS, GROUPS, { kind: "channel", channelId: "slack" })
        .map(allChatsFilterKey)
        .filter((key) => key === "channel:slack"),
    ).toEqual(["channel:slack"]);
  });
});

describe("searchAllChats", () => {
  const displayTitle = (title: string | null | undefined) =>
    title?.trim() ? title : "New chat";
  const rows = [
    conversation("conv-1", { title: "Quarterly plan" }),
    conversation("conv-2", { title: "" }),
  ];

  test("returns every row for an empty query", () => {
    expect(searchAllChats(rows, "  ", displayTitle)).toEqual(rows);
  });

  test("matches the persisted title, ignoring case", () => {
    expect(
      searchAllChats(rows, "QUARTERLY", displayTitle).map(
        (c) => c.conversationId,
      ),
    ).toEqual(["conv-1"]);
  });

  test("matches the label an untitled row renders as", () => {
    expect(
      searchAllChats(rows, "new chat", displayTitle).map(
        (c) => c.conversationId,
      ),
    ).toEqual(["conv-2"]);
  });
});

describe("filterFromSearchParams", () => {
  const available = { groupIds: ["group-a"] };

  test("reads a channel, a group and a named view off the URL", () => {
    expect(
      filterFromSearchParams(new URLSearchParams("channel=slack"), available),
    ).toEqual({ kind: "channel", channelId: "slack" });
    expect(
      filterFromSearchParams(new URLSearchParams("group=group-a"), available),
    ).toEqual({ kind: "group", groupId: "group-a" });
    expect(
      filterFromSearchParams(new URLSearchParams("filter=done"), available),
    ).toEqual({ kind: "done" });
    expect(
      filterFromSearchParams(
        new URLSearchParams("filter=background"),
        available,
      ),
    ).toEqual({ kind: "background" });
  });

  // A window is not a catalog: the rows a channel's chats live in may all be
  // older than the first page, so the link is honoured whatever is loaded.
  test("keeps a channel the loaded window does not show", () => {
    expect(
      filterFromSearchParams(
        new URLSearchParams("channel=telegram"),
        available,
      ),
    ).toEqual({ kind: "channel", channelId: "telegram" });
  });

  test("keeps a plugin channel, which is outside any closed set", () => {
    expect(
      filterFromSearchParams(new URLSearchParams("channel=my-plugin"), {
        groupIds: [],
      }),
    ).toEqual({ kind: "channel", channelId: "my-plugin" });
  });

  test("falls back to All for the native origin, which All already shows", () => {
    expect(
      filterFromSearchParams(new URLSearchParams("channel=vellum"), available),
    ).toEqual({ kind: "all" });
  });

  test("falls back to All for a group that no longer exists", () => {
    expect(
      filterFromSearchParams(new URLSearchParams("group=gone"), available),
    ).toEqual({ kind: "all" });
  });

  test("falls back to All for an empty or unknown query string", () => {
    expect(filterFromSearchParams(new URLSearchParams(""), available)).toEqual({
      kind: "all",
    });
    expect(
      filterFromSearchParams(new URLSearchParams("filter=nope"), available),
    ).toEqual({ kind: "all" });
  });
});

describe("allChatsSearchFor", () => {
  test("round-trips every filter through the URL", () => {
    const available = { groupIds: ["group-a"] };
    for (const filter of allChatsFilters(ROWS, GROUPS)) {
      const search = allChatsSearchFor(filter);
      expect(
        filterFromSearchParams(new URLSearchParams(search), available),
      ).toEqual(filter);
    }
  });

  test("gives the default view no query string at all", () => {
    expect(allChatsSearchFor({ kind: "all" })).toBe("");
  });
});

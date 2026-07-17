import { describe, expect, test } from "bun:test";

import type { SlackChannel } from "@/domains/channels/slack-channels-query";

import {
  classifySlackChannelKind,
  countSlackChannelKinds,
  filterSlackChannels,
  roomsOnly,
  slackChannelMetaLabel,
} from "./slack-channel-list";

function makeChannel(
  overrides: Partial<SlackChannel> & Pick<SlackChannel, "id" | "name">,
): SlackChannel {
  return {
    type: "channel",
    isPrivate: false,
    isMember: true,
    memberCount: null,
    topic: null,
    imageUrl: null,
    ...overrides,
  };
}

const general = makeChannel({ id: "C1", name: "general" });
const leadership = makeChannel({
  id: "C2",
  name: "leadership",
  isPrivate: true,
});
const dmAlice = makeChannel({ id: "D1", name: "Alice", type: "dm" });
const groupDm = makeChannel({
  id: "G1",
  name: "Alice, Bob",
  type: "group",
  isPrivate: true,
});
const ROOMS = [leadership, general, groupDm];

describe("classifySlackChannelKind", () => {
  test("public channels", () => {
    expect(classifySlackChannelKind(general)).toBe("public");
  });

  test("private channels", () => {
    expect(classifySlackChannelKind(leadership)).toBe("private");
  });

  test("DMs are dm regardless of privacy flags", () => {
    expect(classifySlackChannelKind(dmAlice)).toBe("dm");
  });

  test("group DMs count as private", () => {
    expect(classifySlackChannelKind(groupDm)).toBe("private");
  });
});

describe("roomsOnly", () => {
  test("keeps channels and group DMs, drops 1:1 DMs", () => {
    expect(roomsOnly([general, dmAlice, groupDm]).map((c) => c.id)).toEqual([
      "C1",
      "G1",
    ]);
  });
});

describe("filterSlackChannels", () => {
  test("no filters returns everything sorted by name", () => {
    expect(filterSlackChannels(ROOMS, "", null).map((c) => c.id)).toEqual([
      "G1",
      "C1",
      "C2",
    ]);
  });

  test("kind filter narrows to one category", () => {
    expect(filterSlackChannels(ROOMS, "", "private").map((c) => c.id)).toEqual([
      "G1",
      "C2",
    ]);
    expect(filterSlackChannels(ROOMS, "", "public").map((c) => c.id)).toEqual([
      "C1",
    ]);
  });

  test("search is case-insensitive and trims whitespace", () => {
    expect(
      filterSlackChannels(ROOMS, "  LEAD ", null).map((c) => c.id),
    ).toEqual(["C2"]);
  });

  test("search and kind filter compose", () => {
    expect(
      filterSlackChannels(ROOMS, "alice", "private").map((c) => c.id),
    ).toEqual(["G1"]);
  });
});

describe("countSlackChannelKinds", () => {
  test("counts every room kind, independent of search", () => {
    expect(countSlackChannelKinds(ROOMS)).toEqual({
      public: 1,
      private: 2,
      dm: 0,
    });
  });

  test("empty list counts zero everywhere", () => {
    expect(countSlackChannelKinds([])).toEqual({
      public: 0,
      private: 0,
      dm: 0,
    });
  });
});

describe("slackChannelMetaLabel", () => {
  test("rooms show a pluralized member count", () => {
    expect(
      slackChannelMetaLabel(
        makeChannel({ id: "C9", name: "x", memberCount: 24 }),
      ),
    ).toBe("24 members");
    expect(
      slackChannelMetaLabel(
        makeChannel({ id: "C9", name: "x", memberCount: 1 }),
      ),
    ).toBe("1 member");
  });

  test("no member count yields no label", () => {
    expect(slackChannelMetaLabel(general)).toBeNull();
  });
});

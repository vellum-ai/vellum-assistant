import { describe, expect, test } from "bun:test";

import type { SlackChannel } from "@/domains/contacts/types";

import {
  classifySlackChannelKind,
  filterSlackChannels,
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
const leadership = makeChannel({ id: "C2", name: "leadership", isPrivate: true });
const dmAlice = makeChannel({ id: "D1", name: "Alice", type: "dm" });
const groupDm = makeChannel({
  id: "G1",
  name: "Alice, Bob",
  type: "group",
  isPrivate: true,
});
const CHANNELS = [leadership, dmAlice, general, groupDm];

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

describe("filterSlackChannels", () => {
  test("no filters returns everything sorted by name", () => {
    expect(filterSlackChannels(CHANNELS, "", null).map((c) => c.id)).toEqual([
      "D1",
      "G1",
      "C1",
      "C2",
    ]);
  });

  test("kind filter narrows to one category", () => {
    expect(
      filterSlackChannels(CHANNELS, "", "private").map((c) => c.id),
    ).toEqual(["G1", "C2"]);
    expect(filterSlackChannels(CHANNELS, "", "dm").map((c) => c.id)).toEqual([
      "D1",
    ]);
  });

  test("search is case-insensitive and trims whitespace", () => {
    expect(
      filterSlackChannels(CHANNELS, "  LEAD ", null).map((c) => c.id),
    ).toEqual(["C2"]);
  });

  test("search and kind filter compose", () => {
    expect(
      filterSlackChannels(CHANNELS, "alice", "private").map((c) => c.id),
    ).toEqual(["G1"]);
  });
});

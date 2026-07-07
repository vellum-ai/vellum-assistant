import { describe, expect, test } from "bun:test";

import type { ContactPayload, SlackChannel } from "@/domains/contacts/types";

import {
  buildVerifiedSlackContactNames,
  classifySlackChannelKind,
  countSlackChannelKinds,
  filterSlackChannels,
  isVerifiedSlackDm,
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

function makeContact(
  displayName: string,
  channels: Partial<ContactPayload["channels"][number]>[],
): ContactPayload {
  return {
    id: `contact-${displayName}`,
    displayName,
    role: "contact",
    contactType: "human",
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    channels: channels.map((overrides, index) => ({
      id: `ch-${displayName}-${index}`,
      contactId: `contact-${displayName}`,
      type: "slack",
      address: `U${index}`,
      isPrimary: index === 0,
      externalUserId: null,
      lastSeenAt: null,
      interactionCount: null,
      lastInteraction: null,
      ...overrides,
    })),
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

describe("countSlackChannelKinds", () => {
  test("counts every kind, independent of search", () => {
    expect(countSlackChannelKinds(CHANNELS)).toEqual({
      public: 1,
      private: 2,
      dm: 1,
    });
  });

  test("empty list counts zero everywhere", () => {
    expect(countSlackChannelKinds([])).toEqual({ public: 0, private: 0, dm: 0 });
  });
});

describe("slackChannelMetaLabel", () => {
  test("DMs read as direct messages", () => {
    expect(slackChannelMetaLabel(dmAlice)).toBe("Direct message");
  });

  test("channels show a pluralized member count", () => {
    expect(
      slackChannelMetaLabel(makeChannel({ id: "C9", name: "x", memberCount: 24 })),
    ).toBe("24 members");
    expect(
      slackChannelMetaLabel(makeChannel({ id: "C9", name: "x", memberCount: 1 })),
    ).toBe("1 member");
  });

  test("no member count yields no label", () => {
    expect(slackChannelMetaLabel(general)).toBeNull();
  });
});

describe("buildVerifiedSlackContactNames", () => {
  test("collects normalized names of contacts with a verified Slack channel", () => {
    const contacts = [
      makeContact("  Alice ", [{ status: "verified" }]),
      makeContact("Bob", [{ status: "active", verifiedAt: 123 }]),
      makeContact("Mallory", [{ status: "active" }]),
    ];
    expect(buildVerifiedSlackContactNames(contacts)).toEqual(
      new Set(["alice", "bob"]),
    );
  });

  test("ignores verified channels of other types", () => {
    const contacts = [
      makeContact("Carol", [{ type: "telegram", status: "verified" }]),
    ];
    expect(buildVerifiedSlackContactNames(contacts)).toEqual(new Set());
  });
});

describe("isVerifiedSlackDm", () => {
  const verified = new Set(["alice"]);

  test("true only for DMs whose peer name matches (case-insensitive)", () => {
    expect(isVerifiedSlackDm(dmAlice, verified)).toBe(true);
    expect(
      isVerifiedSlackDm(makeChannel({ id: "D2", name: "ALICE", type: "dm" }), verified),
    ).toBe(true);
    expect(
      isVerifiedSlackDm(makeChannel({ id: "D3", name: "Mallory", type: "dm" }), verified),
    ).toBe(false);
  });

  test("false for channels and group DMs regardless of names", () => {
    expect(isVerifiedSlackDm(general, verified)).toBe(false);
    expect(isVerifiedSlackDm(groupDm, verified)).toBe(false);
  });
});

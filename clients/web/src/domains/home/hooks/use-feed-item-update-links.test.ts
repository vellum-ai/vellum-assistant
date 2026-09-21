import { describe, expect, test } from "bun:test";

import { resolveUpdateLinks } from "./use-feed-item-update-links";

const read = (
  conversationId: string,
  overrides: Partial<{
    isPending: boolean;
    isError: boolean;
    exists: boolean;
  }> = {},
) => ({
  conversationId,
  isPending: false,
  isError: false,
  exists: true,
  ...overrides,
});

describe("resolveUpdateLinks", () => {
  test("vouches for the skills the installed list carries and no others", () => {
    const result = resolveUpdateLinks({
      skillIds: ["a", "b"],
      conversationIds: [],
      installedSkillIds: ["a", "c"],
      isSkillsPending: false,
      conversations: [],
    });
    expect([...result.validSkillIds]).toEqual(["a"]);
    expect(result.isPending).toBe(false);
  });

  test("is pending while the skills list this receipt needs is loading", () => {
    const result = resolveUpdateLinks({
      skillIds: ["a"],
      conversationIds: [],
      installedSkillIds: undefined,
      isSkillsPending: true,
      conversations: [],
    });
    expect(result.validSkillIds.size).toBe(0);
    expect(result.isPending).toBe(true);
  });

  test("a receipt naming no skill is never pending on the skills list", () => {
    const result = resolveUpdateLinks({
      skillIds: [],
      conversationIds: ["conv-1"],
      installedSkillIds: undefined,
      isSkillsPending: true,
      conversations: [read("conv-1")],
    });
    expect(result.isPending).toBe(false);
    expect([...result.validConversationIds]).toEqual(["conv-1"]);
  });

  test("drops a conversation whose by-id read 404ed and keeps one that failed otherwise", () => {
    const result = resolveUpdateLinks({
      skillIds: [],
      conversationIds: ["gone", "flaky", "there"],
      installedSkillIds: [],
      isSkillsPending: false,
      conversations: [
        read("gone", { exists: false }),
        read("flaky", { exists: false, isError: true }),
        read("there"),
      ],
    });
    expect([...result.validConversationIds]).toEqual(["flaky", "there"]);
  });

  test("is pending while any conversation read is in flight", () => {
    const result = resolveUpdateLinks({
      skillIds: [],
      conversationIds: ["a", "b"],
      installedSkillIds: [],
      isSkillsPending: false,
      conversations: [read("a"), read("b", { isPending: true, exists: false })],
    });
    expect([...result.validConversationIds]).toEqual(["a"]);
    expect(result.isPending).toBe(true);
  });
});

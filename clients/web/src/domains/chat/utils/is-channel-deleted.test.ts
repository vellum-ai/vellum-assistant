import { describe, expect, test } from "bun:test";

import { isChannelDeleted } from "@/domains/chat/utils/is-channel-deleted";

describe("isChannelDeleted", () => {
  test("true only when the row carries a deletion stamp", () => {
    expect(isChannelDeleted({ deletedAt: 1725100001000 })).toBe(true);
    expect(isChannelDeleted({ deletedAt: undefined })).toBe(false);
    expect(isChannelDeleted({})).toBe(false);
  });
});

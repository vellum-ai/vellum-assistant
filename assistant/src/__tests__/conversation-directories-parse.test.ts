import { describe, expect, test } from "bun:test";

import {
  getConversationDirName,
  parseConversationDirName,
} from "../memory/conversation-directories.js";

describe("parseConversationDirName", () => {
  describe("round-trip with getConversationDirName", () => {
    test("round-trips a UUID-shaped id", () => {
      const id = "4ae7ea90-86e4-446a-8673-7bba94ecfea1";
      const createdAtMs = Date.parse("2026-04-07T10:47:23.075Z");
      const name = getConversationDirName(id, createdAtMs);
      const parsed = parseConversationDirName(name);
      expect(parsed).toEqual({ conversationId: id, createdAtMs });
    });

    test("round-trips an id with embedded hyphens", () => {
      const id = "conv-with-hyphens-123";
      const createdAtMs = Date.parse("2024-01-15T00:00:00.000Z");
      const name = getConversationDirName(id, createdAtMs);
      const parsed = parseConversationDirName(name);
      expect(parsed).toEqual({ conversationId: id, createdAtMs });
    });

    test("round-trips an id with embedded underscores", () => {
      const id = "foo_bar_baz";
      const createdAtMs = Date.parse("2025-12-31T23:59:59.999Z");
      const name = getConversationDirName(id, createdAtMs);
      const parsed = parseConversationDirName(name);
      expect(parsed).toEqual({ conversationId: id, createdAtMs });
    });
  });

  describe("exact parsing against literal example", () => {
    test("parses the canonical example from the spec", () => {
      const name =
        "2026-04-07T10-47-23.075Z_4ae7ea90-86e4-446a-8673-7bba94ecfea1";
      const parsed = parseConversationDirName(name);
      expect(parsed).not.toBeNull();
      expect(parsed?.conversationId).toBe(
        "4ae7ea90-86e4-446a-8673-7bba94ecfea1",
      );
      expect(parsed?.createdAtMs).toBe(Date.parse("2026-04-07T10:47:23.075Z"));
    });
  });

  describe("returns null for malformed input", () => {
    test("returns null for empty string", () => {
      expect(parseConversationDirName("")).toBeNull();
    });

    test("returns null for missing underscore", () => {
      expect(parseConversationDirName("2026-04-07T10-47-23.075Z")).toBeNull();
    });

    test("returns null for legacy format (id first, timestamp second)", () => {
      expect(
        parseConversationDirName(
          "4ae7ea90-86e4-446a-8673-7bba94ecfea1_2026-04-07T10-47-23.075Z",
        ),
      ).toBeNull();
    });

    test("returns null for non-ISO prefix", () => {
      expect(parseConversationDirName("hello_world")).toBeNull();
    });

    test("returns null for random garbage", () => {
      expect(parseConversationDirName("drafts/foo")).toBeNull();
    });

    test("returns null when the conversation id is '.'", () => {
      expect(parseConversationDirName("2025-01-15T00-00-00.000Z_.")).toBeNull();
    });

    test("returns null when the conversation id is '..'", () => {
      expect(
        parseConversationDirName("2025-01-15T00-00-00.000Z_.."),
      ).toBeNull();
    });

    test("returns null when the conversation id contains a forward slash", () => {
      expect(
        parseConversationDirName("2025-01-15T00-00-00.000Z_foo/bar"),
      ).toBeNull();
    });

    test("returns null when the conversation id contains a backslash", () => {
      expect(
        parseConversationDirName("2025-01-15T00-00-00.000Z_foo\\bar"),
      ).toBeNull();
    });
  });

  describe("ids containing underscores", () => {
    test("captures everything after the timestamp as the conversationId", () => {
      const name = "2026-04-07T10-47-23.075Z_my_test_id";
      const parsed = parseConversationDirName(name);
      expect(parsed).not.toBeNull();
      expect(parsed?.conversationId).toBe("my_test_id");
      expect(parsed?.createdAtMs).toBe(Date.parse("2026-04-07T10:47:23.075Z"));
    });
  });
});

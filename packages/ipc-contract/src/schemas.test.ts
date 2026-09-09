/**
 * The notification payload's boundary behaviour. `handle()` in
 * `@vellumai/electron-desktop` parses this payload and a throw rejects the
 * renderer's `invoke`, so what the schema does with a bad `sender` decides
 * whether the user sees a plain banner or none at all.
 */
import { describe, expect, test } from "bun:test";

import { showNotificationPayloadSchema } from "./schemas";
import {
  NOTIFICATION_AVATAR_BASE64_MAX_CHARS,
  NOTIFICATION_AVATAR_HASH_PATTERN,
} from "./types";

const HASH = "a".repeat(64);

const payload = (sender?: unknown) => ({
  category: "activityComplete",
  title: "Done",
  body: "The task finished",
  conversationId: "conv-1",
  ...(sender === undefined ? {} : { sender }),
});

const SENDER = {
  id: "assistant-1",
  name: "Ada",
  avatarBase64: "iVBORw==",
  avatarHash: HASH,
};

describe("showNotificationPayloadSchema", () => {
  test("keeps a well-formed sender", () => {
    expect(showNotificationPayloadSchema.parse(payload(SENDER))).toMatchObject({
      title: "Done",
      sender: SENDER,
    });
  });

  test("parses a payload with no sender at all", () => {
    expect(
      showNotificationPayloadSchema.parse(payload()).sender,
    ).toBeUndefined();
  });

  test.each([
    ["a hash that is not 64 lowercase hex", { ...SENDER, avatarHash: "abc" }],
    ["an uppercase hash", { ...SENDER, avatarHash: HASH.toUpperCase() }],
    ["a path traversal in the hash", { ...SENDER, avatarHash: "../../escape" }],
    [
      "a missing name",
      { id: "assistant-1", avatarBase64: "x", avatarHash: HASH },
    ],
    ["a sender that is not an object", "assistant-1"],
    [
      "an avatar past the byte cap",
      {
        ...SENDER,
        avatarBase64: "A".repeat(NOTIFICATION_AVATAR_BASE64_MAX_CHARS + 1),
      },
    ],
  ])("degrades to no sender for %s", (_label, sender) => {
    const parsed = showNotificationPayloadSchema.parse(payload(sender));

    expect(parsed.sender).toBeUndefined();
    expect(parsed).toMatchObject({
      category: "activityComplete",
      title: "Done",
      body: "The task finished",
      conversationId: "conv-1",
    });
  });

  test("still rejects a payload whose own fields are malformed", () => {
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(SENDER),
        category: "nope",
      }),
    ).toThrow();
  });
});

describe("the notification avatar bounds", () => {
  test("accepts a lowercase hex SHA-256 and nothing else", () => {
    expect(NOTIFICATION_AVATAR_HASH_PATTERN.test(HASH)).toBe(true);
    for (const value of ["", "abc", HASH.toUpperCase(), `${HASH}0`, "../x"]) {
      expect(NOTIFICATION_AVATAR_HASH_PATTERN.test(value)).toBe(false);
    }
  });
});

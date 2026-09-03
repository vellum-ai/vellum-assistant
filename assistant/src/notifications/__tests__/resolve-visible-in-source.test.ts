/**
 * Tests for `resolve-visible-in-source.ts`: when a conversation-scoped
 * producer is allowed to say the user is already watching this.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type pino from "pino";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";

const FLAG = "activity-presence-suppression";
const CONVERSATION_ID = "conv-1";

let webFocused = false;
let webPresenceShouldThrow = false;
const webPresenceArgs: unknown[][] = [];
const realWebPresence = await import("../../runtime/web-presence.js");
mock.module("../../runtime/web-presence.js", () => ({
  ...realWebPresence,
  isWebConversationFocused: (...args: unknown[]) => {
    webPresenceArgs.push(args);
    if (webPresenceShouldThrow) {
      throw new Error("simulated presence read failure");
    }
    return webFocused;
  },
}));

const { resolveVisibleInSourceNow } =
  await import("../resolve-visible-in-source.js");

describe("resolveVisibleInSourceNow", () => {
  beforeEach(() => {
    webFocused = false;
    webPresenceShouldThrow = false;
    webPresenceArgs.length = 0;
    setOverridesForTesting({ [FLAG]: true });
  });

  test("returns true when the flag is on and the conversation is focused", () => {
    webFocused = true;

    expect(resolveVisibleInSourceNow({ conversationId: CONVERSATION_ID })).toBe(
      true,
    );
    expect(webPresenceArgs).toEqual([[CONVERSATION_ID]]);
  });

  test("returns false when the conversation is not focused", () => {
    webFocused = false;

    expect(resolveVisibleInSourceNow({ conversationId: CONVERSATION_ID })).toBe(
      false,
    );
    expect(webPresenceArgs).toEqual([[CONVERSATION_ID]]);
  });

  test("returns false without reading presence when the flag is off", () => {
    webFocused = true;
    setOverridesForTesting({ [FLAG]: false });

    expect(resolveVisibleInSourceNow({ conversationId: CONVERSATION_ID })).toBe(
      false,
    );
    expect(webPresenceArgs).toEqual([]);
  });

  test("returns false and warns once when the presence read throws", () => {
    webPresenceShouldThrow = true;
    const warn = mock(() => {});

    expect(
      resolveVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
        logger: { warn } as unknown as pino.Logger,
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("short-circuits an empty conversation id", () => {
    webFocused = true;

    expect(resolveVisibleInSourceNow({ conversationId: "" })).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });

  test("short-circuits an undefined conversation id", () => {
    webFocused = true;

    expect(resolveVisibleInSourceNow({ conversationId: undefined })).toBe(
      false,
    );
    expect(webPresenceArgs).toEqual([]);
  });
});

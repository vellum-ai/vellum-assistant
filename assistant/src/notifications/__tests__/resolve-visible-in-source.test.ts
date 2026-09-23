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

let guardianPrincipalId: string | undefined = "guardian-1";
let guardianReadShouldThrow = false;
const realGuardianDelivery =
  await import("../../contacts/guardian-delivery-reader.js");
mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  ...realGuardianDelivery,
  getGuardianDelivery: async () => {
    if (guardianReadShouldThrow) {
      throw new Error("recipient unavailable");
    }
    return guardianPrincipalId
      ? [
          {
            channelType: "vellum",
            status: "active",
            principalId: guardianPrincipalId,
          },
        ]
      : null;
  },
}));

const { resolveVisibleInSourceNow, resolveCompletionVisibleInSourceNow } =
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

describe("resolveCompletionVisibleInSourceNow", () => {
  beforeEach(() => {
    guardianPrincipalId = "guardian-1";
    guardianReadShouldThrow = false;
    webFocused = true;
    webPresenceShouldThrow = false;
    webPresenceArgs.length = 0;
    setOverridesForTesting({ "web-presence-suppression": true });
  });

  test("reads attendance only for the completion recipient", async () => {
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
      }),
    ).toBe(true);
    expect(webPresenceArgs).toEqual([
      [CONVERSATION_ID, { actorPrincipalId: "guardian-1" }],
    ]);
  });

  test("does not read unscoped presence when the recipient is unknown", async () => {
    guardianPrincipalId = undefined;
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
      }),
    ).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });

  test("uses an already resolved recipient without a second identity lookup", async () => {
    guardianReadShouldThrow = true;
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
        actorPrincipalId: "guardian-resolved",
      }),
    ).toBe(true);
    expect(webPresenceArgs).toEqual([
      [CONVERSATION_ID, { actorPrincipalId: "guardian-resolved" }],
    ]);
  });

  test("uses the completion presence flag independently of activity suppression", async () => {
    setOverridesForTesting({ "web-presence-suppression": true, [FLAG]: false });
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
      }),
    ).toBe(true);
    setOverridesForTesting({ "web-presence-suppression": false, [FLAG]: true });
    webPresenceArgs.length = 0;
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
      }),
    ).toBe(false);
    expect(webPresenceArgs).toEqual([]);
  });

  test("allows delivery when recipient lookup fails", async () => {
    guardianReadShouldThrow = true;
    const warn = mock(() => {});
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
        logger: { warn } as unknown as pino.Logger,
      }),
    ).toBe(false);
    expect(webPresenceArgs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("allows delivery when presence lookup fails", async () => {
    webPresenceShouldThrow = true;
    const warn = mock(() => {});
    expect(
      await resolveCompletionVisibleInSourceNow({
        conversationId: CONVERSATION_ID,
        logger: { warn } as unknown as pino.Logger,
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

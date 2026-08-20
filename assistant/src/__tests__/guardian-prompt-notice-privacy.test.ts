/**
 * Where a guardian's own gated-tool prompt is addressed.
 *
 * The prompt is raised by a turn the guardian is having, and that turn can be
 * running in a shared room. The card carries the tool name, a preview of the
 * command and live Approve/Reject buttons, so addressing it to the room shows
 * all three to everyone in it and lets any of them press a button.
 *
 * `resolveRequesterDeliveryTarget` already makes this call for the mirror
 * case, a requester-facing notice, so these assertions are as much about the
 * two staying the same shape as about either one in isolation.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveGuardianPromptDeliveryTarget,
  resolveRequesterDeliveryTarget,
} from "../approvals/guardian-channel-delivery.js";

import "./test-preload.js";

const SHARED_ROOM = "C0SHARED123";
const GUARDIAN_USER = "U0GUARDIAN1";

describe("a guardian's prompt on a channel with a private route", () => {
  test("is addressed to the guardian, not to the room the turn is in", () => {
    const target = resolveGuardianPromptDeliveryTarget({
      channel: "slack",
      turnChatId: SHARED_ROOM,
      guardianExternalUserId: GUARDIAN_USER,
    });

    expect(target).toBe(GUARDIAN_USER);
    // Stated as its own assertion rather than left implied by the one above:
    // this is the whole point of the helper, and an implementation that
    // returned the room would still satisfy a weaker "is a string" check.
    expect(target).not.toBe(SHARED_ROOM);
  });

  test("is addressed the same way whether or not the turn is in a room", () => {
    // A guardian already in their own DM must not take a different code path
    // from one in a shared channel. Slack resolves a user id to that same DM,
    // so both land in one place and the prompt has a single shape to reason
    // about.
    expect(
      resolveGuardianPromptDeliveryTarget({
        channel: "slack",
        turnChatId: "D0GUARDIANDM",
        guardianExternalUserId: GUARDIAN_USER,
      }),
    ).toBe(GUARDIAN_USER);
  });
});

describe("channels whose chat is already one-to-one", () => {
  test("keep the prompt in the chat the turn is in", () => {
    for (const channel of ["telegram", "whatsapp"] as const) {
      expect(
        resolveGuardianPromptDeliveryTarget({
          channel,
          turnChatId: "chat-123",
          guardianExternalUserId: GUARDIAN_USER,
        }),
      ).toBe("chat-123");
    }
  });
});

describe("a turn with no resolved guardian identity", () => {
  test("falls back to the chat id rather than addressing an empty user", () => {
    expect(
      resolveGuardianPromptDeliveryTarget({
        channel: "slack",
        turnChatId: SHARED_ROOM,
        guardianExternalUserId: undefined,
      }),
    ).toBe(SHARED_ROOM);
  });
});

describe("the guardian prompt and the requester notice agree", () => {
  test("both address a user id on the channels that have one", () => {
    // One rule, two callers. If a channel is ever added to or removed from
    // `channelDeliversToUserId`, both move together or this fails.
    for (const channel of ["slack", "discord", "telegram", "whatsapp"]) {
      const guardianTarget = resolveGuardianPromptDeliveryTarget({
        channel,
        turnChatId: "chat-1",
        guardianExternalUserId: "user-1",
      });
      const requesterTarget = resolveRequesterDeliveryTarget({
        channel,
        requesterChatId: "chat-1",
        requesterExternalUserId: "user-1",
      });

      expect(guardianTarget).toBe(requesterTarget);
    }
  });
});

import { describe, expect, test } from "bun:test";

import {
  hasCompletionOwnership,
  isCompletionNotification,
  isCompletionRecipientUnavailable,
  isLocalNotificationSilent,
  resolveCompletionRecipient,
} from "../completion-policy.js";

const completion = {
  workId: "task-1",
  conversationId: "conv-1",
  recipientPrincipalId: "principal-1",
  owner: "parent_continuation",
};

describe("completion local delivery policy", () => {
  test("declared completion ownership survives invalid or incomplete metadata", () => {
    for (const payload of [
      completion,
      {},
      null,
      { recipientPrincipalId: "principal-1" },
    ]) {
      expect(
        hasCompletionOwnership({
          sourceEventName: "activity.complete",
          contextPayload: { completion: payload },
        }),
      ).toBe(true);
    }
    expect(
      hasCompletionOwnership({ sourceEventName: "activity.complete" }),
    ).toBe(false);
    expect(
      hasCompletionOwnership({
        sourceEventName: "assistant.share",
        contextPayload: { completion },
      }),
    ).toBe(false);
  });
  test.each(["chat.assistant_reply", "schedule.result"])(
    "%s can banner at medium urgency",
    (sourceEventName) => {
      expect(
        isLocalNotificationSilent({ sourceEventName, urgency: "medium" }),
      ).toBe(false);
    },
  );

  test("background completion requires explicit valid provenance", () => {
    const event = {
      sourceEventName: "activity.complete",
      urgency: "medium" as const,
    };
    expect(isLocalNotificationSilent(event)).toBe(true);
    expect(
      isLocalNotificationSilent({ ...event, contextPayload: { completion } }),
    ).toBe(false);
    expect(
      isCompletionNotification({
        ...event,
        contextPayload: {
          completion: { ...completion, recipientPrincipalId: "" },
        },
      }),
    ).toBe(false);
  });

  test("unrelated medium notifications stay silent and urgent alerts can banner", () => {
    expect(
      isLocalNotificationSilent({
        sourceEventName: "schedule.notify",
        urgency: "medium",
      }),
    ).toBe(true);
    expect(
      isLocalNotificationSilent({
        sourceEventName: "guardian.question",
        urgency: "high",
      }),
    ).toBe(false);
  });

  test("explicit quiet work stays silent even at high urgency", () => {
    expect(
      isLocalNotificationSilent({
        sourceEventName: "schedule.result",
        urgency: "high",
        contextPayload: { quiet: true },
      }),
    ).toBe(true);
  });

  test("missing, blank, or different recipients fail closed", () => {
    const event = {
      sourceEventName: "activity.complete",
      contextPayload: { completion },
    };
    expect(
      resolveCompletionRecipient(event, { channel: "vellum" }),
    ).toBeUndefined();
    expect(
      resolveCompletionRecipient(event, {
        channel: "vellum",
        metadata: { guardianPrincipalId: "  " },
      }),
    ).toBeUndefined();
    expect(
      resolveCompletionRecipient(event, {
        channel: "vellum",
        metadata: { guardianPrincipalId: "other-principal" },
      }),
    ).toBeUndefined();
    expect(
      resolveCompletionRecipient(event, {
        channel: "vellum",
        metadata: { guardianPrincipalId: "principal-1" },
      }),
    ).toBe("principal-1");
  });

  test("typed background completion requires its recipient on both local and mobile delivery", () => {
    const event = {
      sourceEventName: "activity.complete",
      contextPayload: { completion },
    };
    for (const channel of ["vellum", "platform"] as const) {
      for (const guardianPrincipalId of [undefined, "", "other-principal"]) {
        expect(
          isCompletionRecipientUnavailable(event, {
            channel,
            metadata: { guardianPrincipalId },
          }),
        ).toBe(true);
      }
      expect(
        isCompletionRecipientUnavailable(event, {
          channel,
          metadata: { guardianPrincipalId: "principal-1" },
        }),
      ).toBe(false);
    }
  });

  test.each([
    undefined,
    null,
    {},
    "principal-1",
    { ...completion, recipientPrincipalId: " " },
    { ...completion, conversationId: "" },
    { ...completion, owner: "unknown" },
  ])(
    "malformed ownership %j cannot resolve a recipient or reach any channel",
    (payload) => {
      const event = {
        sourceEventName: "activity.complete",
        contextPayload: { completion: payload },
      };
      for (const channel of [
        "vellum",
        "platform",
        "slack",
        "telegram",
        "discord",
      ] as const) {
        for (const guardianPrincipalId of [undefined, "principal-1"]) {
          const destination = { channel, metadata: { guardianPrincipalId } };
          expect(
            resolveCompletionRecipient(event, destination),
          ).toBeUndefined();
          expect(isCompletionRecipientUnavailable(event, destination)).toBe(
            true,
          );
        }
      }
    },
  );

  test("ordinary activity events retain their delivery policy", () => {
    for (const channel of ["vellum", "platform", "slack"] as const) {
      expect(
        isCompletionRecipientUnavailable(
          {
            sourceEventName: "activity.complete",
            contextPayload: { body: "Task finished." },
          },
          { channel },
        ),
      ).toBe(false);
    }
    expect(
      isCompletionRecipientUnavailable(
        {
          sourceEventName: "assistant.share",
          contextPayload: { completion: null },
        },
        { channel: "vellum" },
      ),
    ).toBe(false);
  });

  test.each(["slack", "telegram", "discord"] as const)(
    "owned completion cannot opt into %s through routing metadata",
    (channel) => {
      for (const guardianPrincipalId of [
        undefined,
        "principal-1",
        "other-principal",
      ]) {
        expect(
          isCompletionRecipientUnavailable(
            {
              sourceEventName: "activity.complete",
              contextPayload: { completion, channelAllowlist: [channel] },
            },
            { channel, metadata: { guardianPrincipalId } },
          ),
        ).toBe(true);
      }
    },
  );

  test.each(["chat.assistant_reply", "schedule.result"])(
    "%s retains the platform owner fallback when the guardian lookup is unavailable",
    (sourceEventName) => {
      expect(
        isCompletionRecipientUnavailable(
          { sourceEventName },
          { channel: "platform" },
        ),
      ).toBe(false);
      expect(
        isCompletionRecipientUnavailable(
          { sourceEventName },
          { channel: "vellum" },
        ),
      ).toBe(true);
    },
  );
});

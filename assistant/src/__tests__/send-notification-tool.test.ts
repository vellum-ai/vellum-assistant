import { beforeEach, describe, expect, mock, test } from "bun:test";

const emitNotificationSignalMock = mock(async (_params: unknown) => {});

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: unknown) =>
    emitNotificationSignalMock(params),
}));

import { run } from "../config/bundled-skills/notifications/tools/send-notification.js";

describe("send-notification tool", () => {
  beforeEach(() => {
    emitNotificationSignalMock.mockClear();
  });

  test("emits a notification signal with normalized routing context", async () => {
    const result = await run(
      {
        message: "Your verification code is 123456",
        title: "Verification code",
        urgency: "high",
        conversation_id: "conv-override",
        requires_action: true,
        preferred_channels: ["vellum"],
        deep_link_metadata: { conversationId: "conv-deeplink" },
        dedupe_key: "voice-code-123456",
      },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(false);
    expect(emitNotificationSignalMock).toHaveBeenCalledTimes(1);
    expect(emitNotificationSignalMock).toHaveBeenCalledWith({
      sourceEventName: "user.send_notification",
      sourceChannel: "assistant_tool",
      sourceSessionId: "conv-override",
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        deadlineAt: undefined,
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestedMessage: "Your verification code is 123456",
        requestedByTool: "send_notification",
        requestedBySessionId: "conv-1",
        requestedTitle: "Verification code",
        requestedByConversationId: "conv-override",
        preferredChannels: ["vellum"],
        deepLinkMetadata: { conversationId: "conv-deeplink" },
      },
      dedupeKey: "voice-code-123456",
      throwOnError: true,
    });
  });

  test("returns an error when the notification pipeline throws", async () => {
    emitNotificationSignalMock.mockImplementationOnce(async () => {
      throw new Error("database unavailable");
    });

    const result = await run(
      { message: "test notification" },
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        assistantId: "ast-alpha",
        trustClass: "guardian" as const,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("database unavailable");
    expect(emitNotificationSignalMock).toHaveBeenCalledTimes(1);
  });
});

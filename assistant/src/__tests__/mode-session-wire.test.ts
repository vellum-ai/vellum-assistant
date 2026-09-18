import { describe, expect, test } from "bun:test";

import { AssistantTextDeltaEventSchema } from "../api/events/assistant-text-delta.js";
import { AssistantThinkingDeltaEventSchema } from "../api/events/assistant-thinking-delta.js";
import { AssistantTurnStartEventSchema } from "../api/events/assistant-turn-start.js";
import { GenerationHandoffEventSchema } from "../api/events/generation-handoff.js";
import { MessageCompleteEventSchema } from "../api/events/message-complete.js";
import { ToolResultEventSchema } from "../api/events/tool-result.js";
import { ToolUseStartEventSchema } from "../api/events/tool-use-start.js";
import { UserMessageEchoEventSchema } from "../api/events/user-message-echo.js";
import {
  ModeSessionDescriptorSchema,
  ModeSessionSchema,
} from "../api/mode-session.js";
import { ConversationMessageSchema } from "../api/responses/conversation-message.js";
import { messageMetadataSchema } from "../persistence/conversation-crud.js";

const owner = { mode: "browser", id: "session-123" } as const;

describe("mode session wire contract", () => {
  test("accepts canonical membership on history and row-boundary events", () => {
    expect(ModeSessionSchema.parse(owner)).toEqual(owner);
    expect(
      ConversationMessageSchema.parse({
        id: "message-123",
        role: "assistant",
        timestamp: new Date(0).toISOString(),
        attachments: [],
        contentBlocks: [],
        modeSession: owner,
        modeSessionActivity: { firstAt: 100, lastAt: 150 },
      }).modeSession,
    ).toEqual(owner);

    const boundaryEvents = [
      UserMessageEchoEventSchema.parse({
        type: "user_message_echo",
        text: "Continue",
        modeSession: owner,
      }),
      AssistantTurnStartEventSchema.parse({
        type: "assistant_turn_start",
        messageId: "message-123",
        modeSession: owner,
      }),
      ToolUseStartEventSchema.parse({
        type: "tool_use_start",
        toolName: "browser_navigate",
        input: {},
        modeSession: owner,
      }),
      ToolResultEventSchema.parse({
        type: "tool_result",
        toolName: "browser_navigate",
        result: "Complete",
        modeSession: owner,
      }),
      MessageCompleteEventSchema.parse({
        type: "message_complete",
        modeSession: owner,
      }),
      GenerationHandoffEventSchema.parse({
        type: "generation_handoff",
        queuedCount: 1,
        modeSession: owner,
      }),
    ];
    expect(
      boundaryEvents.every((event) => event.modeSession?.id === owner.id),
    ).toBe(true);
  });

  test("keeps text and thinking deltas free of session fields", () => {
    expect(
      AssistantTextDeltaEventSchema.parse({
        type: "assistant_text_delta",
        text: "Working",
        modeSession: owner,
      }),
    ).not.toHaveProperty("modeSession");
    expect(
      AssistantThinkingDeltaEventSchema.parse({
        type: "assistant_thinking_delta",
        thinking: "Checking",
        modeSession: owner,
      }),
    ).not.toHaveProperty("modeSession");
  });

  test("exposes runtime state only for active summaries", () => {
    const summary = {
      id: "session-123",
      conversationId: "conv-123",
      mode: "browser",
      status: "active",
      sourceStartedAt: 100,
      firstIncludedAt: null,
      firstIncludedMessageId: null,
      lastActivityAt: 100,
      lastOwnedMessageId: null,
      endedAt: null,
      endReason: null,
      revision: 1,
    } as const;
    expect(
      ModeSessionDescriptorSchema.parse({
        summary,
        runtimeState: "waiting",
      }).runtimeState,
    ).toBe("waiting");
    expect(
      ModeSessionDescriptorSchema.safeParse({
        summary: {
          ...summary,
          status: "completed",
          endedAt: 120,
          endReason: "settled",
        },
        runtimeState: "finishing",
      }).success,
    ).toBe(false);
  });

  test("types canonical metadata while preserving unrelated keys", () => {
    expect(
      messageMetadataSchema.parse({
        modeSession: owner,
        futureMetadata: { value: true },
      }),
    ).toEqual({
      modeSession: owner,
      futureMetadata: { value: true },
    });
    expect(
      messageMetadataSchema.parse({
        modeSession: { mode: "unknown", id: "session-123" },
        futureMetadata: { value: true },
      }),
    ).toEqual({ futureMetadata: { value: true } });
  });
});

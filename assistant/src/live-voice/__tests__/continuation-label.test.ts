import { describe, expect, mock, test } from "bun:test";

import type { Provider, ProviderResponse } from "../../providers/types.js";
import {
  buildDuplexContinuationLabel,
  createContinuationLabeler,
  DUPLEX_CONTINUATION_FALLBACK_LABEL,
} from "../continuation-label.js";

describe("buildDuplexContinuationLabel", () => {
  test("names the continuation after the interrupted request", () => {
    expect(buildDuplexContinuationLabel("what's on my calendar tomorrow")).toBe(
      "What's on my calendar tomorrow",
    );
  });

  test("collapses transcript whitespace between segments", () => {
    expect(
      buildDuplexContinuationLabel("  check my   reminders \n please "),
    ).toBe("Check my reminders please");
  });

  test("cuts a long request to conversation-title length", () => {
    const label = buildDuplexContinuationLabel(
      "can you go through every email from last week and tell me which ones still need a reply from me",
    );
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toBe("Can you go through every");
  });

  test("falls back to a plain description when no transcript landed", () => {
    expect(buildDuplexContinuationLabel("")).toBe(
      DUPLEX_CONTINUATION_FALLBACK_LABEL,
    );
    expect(buildDuplexContinuationLabel("   ")).toBe(
      DUPLEX_CONTINUATION_FALLBACK_LABEL,
    );
  });
});

function labelResponse(label: string): ProviderResponse {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu-1",
        name: "record_task_label",
        input: { label },
      },
    ],
    stopReason: "tool_use",
  } as unknown as ProviderResponse;
}

function stubProvider(sendMessage: Provider["sendMessage"]): Provider {
  return { name: "stub", sendMessage: mock(sendMessage) } as Provider;
}

const LABEL_ARGS = {
  parentConversationId: "conversation-123",
  interruptedRequest: "um so can you like check what's on my calendar tomorrow",
  signal: new AbortController().signal,
};

describe("createContinuationLabeler", () => {
  test("phrases the interrupted transcript through the label call site", async () => {
    let captured: Parameters<Provider["sendMessage"]> | undefined;
    const labeler = createContinuationLabeler({
      getProvider: async () =>
        stubProvider(async (...args) => {
          captured = args;
          return labelResponse("Checking tomorrow's calendar");
        }),
    });

    expect(await labeler(LABEL_ARGS)).toBe("Checking tomorrow's calendar");

    const config = captured?.[1]?.config as Record<string, unknown>;
    expect(config.callSite).toBe("voiceContinuationLabel");
    expect(config.conversationId).toBe("conversation-123");
    expect(config.tool_choice).toEqual({
      type: "tool",
      name: "record_task_label",
    });
    const prompt = (captured?.[0]?.[0]?.content as Array<{ text: string }>)[0]
      ?.text;
    expect(prompt).toContain(LABEL_ARGS.interruptedRequest);
  });

  test("resolves null when the model declines", async () => {
    const labeler = createContinuationLabeler({
      getProvider: async () => stubProvider(async () => labelResponse("")),
    });
    expect(await labeler(LABEL_ARGS)).toBeNull();
  });

  test("resolves null when no provider is configured", async () => {
    const labeler = createContinuationLabeler({
      getProvider: async () => null,
    });
    expect(await labeler(LABEL_ARGS)).toBeNull();
  });
});

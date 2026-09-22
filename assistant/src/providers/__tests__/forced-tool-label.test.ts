import { describe, expect, mock, test } from "bun:test";

import {
  requestShortLabel,
  type ShortLabelTool,
} from "../forced-tool-label.js";
import type { Provider, ProviderResponse } from "../types.js";

const TOOL: ShortLabelTool = {
  name: "record_label",
  description: "Record the label.",
  argument: "label",
  argumentDescription: "A short label.",
};

function toolResponse(input: unknown, name = TOOL.name): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: "tu-1", name, input }],
    stopReason: "tool_use",
  } as unknown as ProviderResponse;
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  } as unknown as ProviderResponse;
}

function stubProvider(sendMessage: Provider["sendMessage"]): Provider {
  return { name: "stub", sendMessage: mock(sendMessage) } as Provider;
}

function request(provider: Provider, signal?: AbortSignal) {
  return requestShortLabel({
    provider,
    callSite: "conversationTitle",
    conversationId: "conv-1",
    systemPrompt: "Name it.",
    prompt: "Some content",
    tool: TOOL,
    timeoutMs: 5_000,
    maxTokens: 64,
    signal,
  });
}

describe("requestShortLabel", () => {
  test("forces the tool and returns its normalized argument", async () => {
    const provider = stubProvider(async () =>
      toolResponse({ label: '  "Checking the calendar"  ' }),
    );

    expect(await request(provider)).toBe("Checking the calendar");

    const [, options] = (provider.sendMessage as ReturnType<typeof mock>).mock
      .calls[0] as [unknown, Record<string, unknown>];
    const config = options.config as Record<string, unknown>;
    expect(config.callSite).toBe("conversationTitle");
    expect(config.conversationId).toBe("conv-1");
    expect(config.tool_choice).toEqual({ type: "tool", name: TOOL.name });
    expect((options.tools as Array<{ name: string }>)[0]?.name).toBe(TOOL.name);
  });

  test("keeps a compliant plain-text answer when the tool is ignored", async () => {
    const provider = stubProvider(async () =>
      textResponse("Checking the calendar"),
    );
    expect(await request(provider)).toBe("Checking the calendar");
  });

  test("returns empty when the model answers in prose instead", async () => {
    const provider = stubProvider(async () =>
      textResponse("I need to look at the calendar first and then respond."),
    );
    expect(await request(provider)).toBe("");
  });

  test("returns empty when the tool carries the wrong argument", async () => {
    const provider = stubProvider(async () => toolResponse({ title: "Nope" }));
    expect(await request(provider)).toBe("");
  });

  test("rejects when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const provider = stubProvider(
      (_messages, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const pending = request(provider, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

import { describe, expect, test } from "bun:test";

import type { LlmLogPayload } from "@/domains/chat/lib/inspector-payload-api.js";
import type { LlmContextResponse } from "@/domains/chat/lib/inspector-types.js";

import {
  buildInspectorExportFilename,
  buildInspectorExportFiles,
} from "@/domains/chat/lib/inspector-export.js";

function makeContext(): LlmContextResponse {
  return {
    messageId: "msg/with spaces",
    conversationKind: "chat",
    conversationTotalEstimatedCostUsd: 0.0123,
    memoryRecall: {
      enabled: true,
      degraded: false,
      provider: "openai",
      model: "text-embedding-3-small",
      degradation: null,
      topCandidates: [],
      injectedText: "memory text",
      reason: null,
      queryContext: "query",
    },
    memoryV2Activation: null,
    logs: [
      {
        id: "log/alpha",
        createdAt: 1_715_200_000_000,
        provider: "anthropic",
        requestPayload: null,
        responsePayload: null,
        summary: {
          provider: "anthropic",
          model: "claude-sonnet",
          status: "success",
          stopReason: "end_turn",
          estimatedCostUsd: 0.01,
        },
        requestSections: [
          {
            kind: "message",
            role: "system",
            label: "System",
            text: "system prompt",
          },
          {
            kind: "message",
            role: "user",
            label: "User",
            text: "what did I actually send?",
            data: { messageId: "user-message-1" },
          },
        ],
        responseSections: [
          {
            kind: "message",
            role: "assistant",
            label: "Assistant",
            text: "answer",
          },
        ],
      },
    ],
  };
}

function makePayloads(): LlmLogPayload[] {
  return [
    {
      id: "log/alpha",
      requestPayload: {
        messages: [{ role: "user", content: "provider envelope" }],
      },
      responsePayload: {
        content: [{ type: "text", text: "provider response" }],
      },
    },
  ];
}

function fileContents(files: ReturnType<typeof buildInspectorExportFiles>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing export file ${path}`);
  return file.contents;
}

describe("inspector export", () => {
  test("builds a safe zip filename from the message id", () => {
    expect(buildInspectorExportFilename("msg/with spaces")).toBe(
      "llm-inspector-msg_with_spaces.zip",
    );
  });

  test("separates human conversation context from provider payloads", () => {
    const files = buildInspectorExportFiles(makeContext(), makePayloads(), {
      exportedAt: "2026-05-15T13:00:00.000Z",
    });

    expect(files.map((file) => file.path)).toEqual([
      "README.md",
      "manifest.json",
      "conversation/actual-user-messages.json",
      "conversation/llm-calls.json",
      "memory/memory-recall.json",
      "memory/memory-v2-activation.json",
      "normalized-context/calls/001-log_alpha/summary.json",
      "normalized-context/calls/001-log_alpha/request-sections.json",
      "normalized-context/calls/001-log_alpha/response-sections.json",
      "provider-payloads/calls/001-log_alpha/request.json",
      "provider-payloads/calls/001-log_alpha/response.json",
    ]);

    expect(
      JSON.parse(fileContents(files, "conversation/actual-user-messages.json")),
    ).toMatchObject({
      messageId: "msg/with spaces",
      messages: [
        {
          callId: "log/alpha",
          callIndex: 0,
          sectionIndex: 1,
          role: "user",
          text: "what did I actually send?",
        },
      ],
    });

    expect(
      JSON.parse(
        fileContents(files, "provider-payloads/calls/001-log_alpha/request.json"),
      ),
    ).toEqual({
      messages: [{ role: "user", content: "provider envelope" }],
    });
  });
});

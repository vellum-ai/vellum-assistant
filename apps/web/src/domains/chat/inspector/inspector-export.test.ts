import { describe, expect, test } from "bun:test";

import type { LlmLogPayload } from "@/domains/chat/inspector/inspector-payload-api";
import type { LlmContextResponse } from "@vellumai/assistant-api";

import {
  buildInspectorExportFilename,
  buildInspectorExportFiles,
  buildInspectorExportZipBlob,
} from "@/domains/chat/inspector/inspector-export";

function makeContext(): LlmContextResponse {
  return {
    conversationId: "conv/with spaces",
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
  test("builds a safe zip filename from the conversation id", () => {
    expect(buildInspectorExportFilename("conv/with spaces")).toBe(
      "llm-inspector-conv_with_spaces.zip",
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
      conversationId: "conv/with spaces",
      messageId: null,
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

  test("hydrates section-less logs through the fetcher, skipping inline ones", async () => {
    const context = makeContext();
    context.logs.push({
      id: "log/beta",
      createdAt: 1_715_200_000_001,
      requestPayload: null,
      responsePayload: null,
    });
    const fetchedIds: string[] = [];

    const blob = await buildInspectorExportZipBlob(
      context,
      makePayloads(),
      async (logId) => {
        fetchedIds.push(logId);
        return {
          requestSections: [
            { kind: "message", role: "user", label: "User", text: "hi" },
          ],
          responseSections: [],
        };
      },
    );

    expect(blob.size).toBeGreaterThan(0);
    expect(fetchedIds).toEqual(["log/beta"]);
  });

  test("propagates fetcher failures instead of exporting incomplete data", async () => {
    const context = makeContext();
    context.logs.push({
      id: "log/beta",
      createdAt: 1_715_200_000_001,
      requestPayload: null,
      responsePayload: null,
    });

    await expect(
      buildInspectorExportZipBlob(context, makePayloads(), async () => {
        throw new Error("detail fetch failed");
      }),
    ).rejects.toThrow("detail fetch failed");
  });
});

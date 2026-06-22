import { describe, expect, test } from "bun:test";

import type { LlmLogPayload } from "@/domains/chat/inspector/inspector-payload-api";
import type { LlmContextResponse } from "@vellumai/assistant-api";

import {
  buildInspectorExportFilename,
  buildInspectorExportFiles,
  buildInspectorExportZipBlob,
  buildInspectorExportZipBlobBatched,
  INSPECTOR_EXPORT_CONCURRENCY,
  type InspectorExportProgress,
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

function makeManyLogContext(count: number): LlmContextResponse {
  return {
    conversationId: "conv",
    conversationKind: "chat",
    conversationTotalEstimatedCostUsd: null,
    memoryRecall: null,
    memoryV2Activation: null,
    // Section-less logs so the export hits both the payload and section fetchers.
    logs: Array.from({ length: count }, (_, index) => ({
      id: `log/${index}`,
      createdAt: 1_715_200_000_000 + index,
      requestPayload: null,
      responsePayload: null,
    })),
  };
}

function payloadFor(logId: string): LlmLogPayload {
  return { id: logId, requestPayload: null, responsePayload: null };
}

describe("inspector export (batched)", () => {
  test("never exceeds the concurrency cap across both fetch phases", async () => {
    const context = makeManyLogContext(35);
    let inFlight = 0;
    let peak = 0;

    const track = async <T,>(produce: () => T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return produce();
    };

    const blob = await buildInspectorExportZipBlobBatched(context, {
      fetchPayload: (logId) => track(() => payloadFor(logId)),
      fetchCallSections: (logId) =>
        track(() => ({
          requestSections: [
            { kind: "message", role: "user", label: "User", text: logId },
          ],
          responseSections: [],
        })),
    });

    expect(blob.size).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(INSPECTOR_EXPORT_CONCURRENCY);
  });

  test("reports monotonic progress that ends at the total request count", async () => {
    const context = makeManyLogContext(7);
    const updates: InspectorExportProgress[] = [];

    await buildInspectorExportZipBlobBatched(context, {
      fetchPayload: async (logId) => payloadFor(logId),
      fetchCallSections: async (logId) => ({
        requestSections: [
          { kind: "message", role: "user", label: "User", text: logId },
        ],
        responseSections: [],
      }),
      onProgress: (progress) => updates.push({ ...progress }),
    });

    // 7 payload fetches + 7 section fetches.
    const total = 14;
    expect(updates[0]).toEqual({ completed: 0, total });
    expect(updates.at(-1)).toEqual({ completed: total, total });
    for (let i = 1; i < updates.length; i += 1) {
      expect(updates[i]!.completed).toBeGreaterThanOrEqual(
        updates[i - 1]!.completed,
      );
      expect(updates[i]!.total).toBe(total);
    }
  });

  test("stops fetching once the signal aborts", async () => {
    const context = makeManyLogContext(40);
    const controller = new AbortController();
    let fetchCount = 0;

    const promise = buildInspectorExportZipBlobBatched(context, {
      concurrency: 4,
      fetchPayload: async (logId) => {
        fetchCount += 1;
        if (fetchCount === 6) controller.abort();
        return payloadFor(logId);
      },
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow();
    // A few in-flight workers may finish, but it must not run all 40 logs.
    expect(fetchCount).toBeLessThan(context.logs.length);
  });
});

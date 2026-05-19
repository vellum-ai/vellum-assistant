import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@/domains/chat/lib/inspector-types.js";

import {
  buildRawPayloadFilename,
  formatPayload,
  RawTab,
} from "@/components/app/assistant/message-inspector/tabs/raw-tab.js";

function makeEntry(
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id: "log/with spaces",
    createdAt: 1_715_200_000_000,
    requestPayload: null,
    responsePayload: null,
    summary: null,
    requestSections: [],
    responseSections: [],
    ...overrides,
  };
}

describe("RawTab helpers", () => {
  test("formats structured payloads as pretty JSON", () => {
    expect(formatPayload({ messages: [{ role: "user", content: "hi" }] })).toBe(
      '{\n  "messages": [\n    {\n      "role": "user",\n      "content": "hi"\n    }\n  ]\n}',
    );
  });

  test("keeps string payloads unchanged", () => {
    expect(formatPayload('{"already":"json"}')).toBe('{"already":"json"}');
  });

  test("builds safe per-pane download filenames", () => {
    expect(buildRawPayloadFilename("log/with spaces", "request")).toBe(
      "llm-log_with_spaces-request.json",
    );
    expect(buildRawPayloadFilename("abc-123", "response")).toBe(
      "llm-abc-123-response.json",
    );
  });
});

describe("RawTab", () => {
  test("renders download and copy controls for the selected pane", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      [
        "assistants",
        "assistant-1",
        "llm-request-logs",
        "log/with spaces",
        "payload",
      ],
      {
        id: "log/with spaces",
        requestPayload: { messages: [{ role: "user", content: "hi" }] },
        responsePayload: { content: [{ type: "text", text: "hello" }] },
      },
    );

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RawTab, {
          entry: makeEntry(),
          assistantId: "assistant-1",
        }),
      ),
    );

    expect(html).toContain("Download request payload");
    expect(html).toContain("Copy request payload");
  });
});

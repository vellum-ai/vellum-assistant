/**
 * Tests for the CacheBreakpointMapCard rendering. Renders to static markup
 * (no DOM), mirroring `cache-diff-card.test.tsx`. The card fetches the raw
 * request payload through `useLlmLogPayload`, so each case seeds that
 * query into a `QueryClient` (keeping the query fresh and offline) and
 * wraps the render in a `QueryClientProvider`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CacheBreakpointMapCard } from "./cache-breakpoint-map-card";
import type { LLMCallSummary, LLMRequestLogEntry } from "@vellumai/assistant-api";

const ASSISTANT_ID = "assistant-1";

function marker(ttl: string) {
  return { type: "ephemeral", ttl };
}

function text(value: string, cacheControl?: { type: string; ttl: string }) {
  return {
    type: "text",
    text: value,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

function cachedRequest() {
  return {
    model: "claude-sonnet-4",
    tools: [
      {
        name: "read",
        description: "Read a file",
        input_schema: {},
        cache_control: marker("1h"),
      },
    ],
    system: [text("You are a helpful assistant.", marker("1h"))],
    messages: [
      { role: "user", content: [text("first question", marker("1h"))] },
      { role: "user", content: [text("follow-up", marker("5m"))] },
    ],
  };
}

function entry(id: string, overrides: Partial<LLMCallSummary>): LLMRequestLogEntry {
  return {
    id,
    createdAt: Date.parse("2026-06-13T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    provider: overrides.provider ?? "anthropic",
    summary: { provider: "anthropic", model: "claude-sonnet-4", ...overrides },
  };
}

function render(call: LLMRequestLogEntry, requestPayload: unknown): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(
    ["assistants", ASSISTANT_ID, "llm-request-logs", call.id, "payload"],
    { id: call.id, requestPayload, responsePayload: null },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CacheBreakpointMapCard entry={call} assistantId={ASSISTANT_ID} />
    </QueryClientProvider>,
  );
}

describe("CacheBreakpointMapCard", () => {
  test("renders nothing for a non-Anthropic call", () => {
    const call = entry("call-openai", {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(render(call, cachedRequest())).toBe("");
  });

  test("maps each cache segment with its label and token footnote", () => {
    const call = entry("call-1", {
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 4000,
    });
    const html = render(call, cachedRequest());

    expect(html).toContain("Cache breakpoints");
    expect(html).toContain("Tools");
    expect(html).toContain("System prompt");
    expect(html).toContain("User message #1");
    expect(html).toContain("Token counts are estimated");
  });

  test("warns about a full cache miss when nothing was read", () => {
    const call = entry("call-miss", {
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 4000,
    });
    const html = render(call, cachedRequest());

    expect(html).toContain("Full cache miss");
    expect(html).toContain("Re-created");
  });

  test("shows the read legend on a full cache hit", () => {
    const call = entry("call-hit", {
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 0,
    });
    const html = render(call, cachedRequest());

    expect(html).toContain("Read from cache");
    expect(html).not.toContain("Full cache miss");
  });

  test("notes when caching was disabled for the call", () => {
    const call = entry("call-disabled", {});
    const request = {
      model: "claude-sonnet-4",
      system: [text("You are a helpful assistant.")],
      messages: [{ role: "user", content: [text("hi")] }],
    };
    const html = render(call, request);

    expect(html).toContain("prompt caching was disabled");
  });
});

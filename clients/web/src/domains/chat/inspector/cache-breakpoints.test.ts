/**
 * Tests for the pure cache-breakpoint logic. Each case builds an
 * Anthropic-shaped request payload with `cache_control` markers and an
 * accompanying call summary, then asserts the segmentation (one segment
 * per marker, in tools → system → messages order), the per-segment
 * read/created classification, and the estimated token totals.
 */

import { describe, expect, test } from "bun:test";

import { parseCacheBreakpoints } from "./cache-breakpoints";
import type { LLMCallSummary } from "@vellumai/assistant-api";

const STABLE_TTL = "1h";
const TAIL_TTL = "5m";

interface CacheMarker {
  type: "ephemeral";
  ttl: string;
}

function marker(ttl: string): CacheMarker {
  return { type: "ephemeral", ttl };
}

function text(value: string, cacheControl?: CacheMarker) {
  return {
    type: "text",
    text: value,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

/**
 * A realistic four-breakpoint Anthropic request: a cached tool list, a
 * single cached system block, a turn-start anchor on the first user
 * message, and an advancing 5m tail on the latest user message.
 */
function fourBreakpointRequest() {
  return {
    model: "claude-sonnet-4",
    tools: [
      { name: "read", description: "Read a file", input_schema: {} },
      {
        name: "write",
        description: "Write a file",
        input_schema: {},
        cache_control: marker(STABLE_TTL),
      },
    ],
    system: [text("You are a helpful assistant.", marker(STABLE_TTL))],
    messages: [
      { role: "user", content: [text("first question", marker(STABLE_TTL))] },
      { role: "assistant", content: [text("an answer")] },
      { role: "user", content: [text("follow-up question", marker(TAIL_TTL))] },
    ],
  };
}

function summary(overrides: Partial<LLMCallSummary>): LLMCallSummary {
  return { provider: "anthropic", model: "claude-sonnet-4", ...overrides };
}

describe("parseCacheBreakpoints", () => {
  test("returns null for a non-object payload", () => {
    expect(parseCacheBreakpoints(null, summary({}))).toBeNull();
    expect(parseCacheBreakpoints("not json", summary({}))).toBeNull();
  });

  test("returns null for a non-Anthropic request without markers", () => {
    const openAiRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(
      parseCacheBreakpoints(openAiRequest, summary({ provider: "openai" })),
    ).toBeNull();
  });

  test("segments the prefix in tools → system → messages order", () => {
    const map = parseCacheBreakpoints(
      fourBreakpointRequest(),
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 }),
    );

    expect(map).not.toBeNull();
    expect(map?.segments.map((segment) => segment.label)).toEqual([
      "Tools",
      "System prompt",
      "User message #1",
      "User message #3",
    ]);
    expect(map?.segments.map((segment) => segment.region)).toEqual([
      "tools",
      "system",
      "messages",
      "messages",
    ]);
  });

  test("captures the cache_control ttl on each closing breakpoint", () => {
    const map = parseCacheBreakpoints(
      fourBreakpointRequest(),
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 }),
    );

    expect(map?.segments.map((segment) => segment.ttl)).toEqual([
      STABLE_TTL,
      STABLE_TTL,
      STABLE_TTL,
      TAIL_TTL,
    ]);
  });

  test("marks every segment created on a full cache miss", () => {
    const map = parseCacheBreakpoints(
      fourBreakpointRequest(),
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 }),
    );

    expect(map?.segments.every((segment) => segment.status === "created")).toBe(
      true,
    );
    expect(map?.splitEstimated).toBe(false);
  });

  test("marks every segment read on a full cache hit", () => {
    const map = parseCacheBreakpoints(
      fourBreakpointRequest(),
      summary({ cacheReadInputTokens: 4000, cacheCreationInputTokens: 0 }),
    );

    expect(map?.segments.every((segment) => segment.status === "read")).toBe(
      true,
    );
    expect(map?.splitEstimated).toBe(false);
  });

  test("splits read from created at a breakpoint boundary by size", () => {
    const block = "x".repeat(400);
    const request = {
      model: "claude-sonnet-4",
      system: [text(block, marker(STABLE_TTL))],
      messages: [
        { role: "user", content: [text(block, marker(STABLE_TTL))] },
        { role: "assistant", content: [text(block, marker(STABLE_TTL))] },
        { role: "user", content: [text(block, marker(TAIL_TTL))] },
      ],
    };

    // Each of the four segments estimates to ~100 tokens; a 300/100
    // read/created split should land the boundary after the third segment.
    const map = parseCacheBreakpoints(
      request,
      summary({ cacheReadInputTokens: 300, cacheCreationInputTokens: 100 }),
    );

    expect(map?.segments.map((segment) => segment.status)).toEqual([
      "read",
      "read",
      "read",
      "created",
    ]);
    expect(map?.splitEstimated).toBe(true);
  });

  test("scales segment estimates to the reported cacheable total", () => {
    const block = "x".repeat(400);
    const request = {
      model: "claude-sonnet-4",
      system: [text(block, marker(STABLE_TTL))],
      messages: [
        { role: "user", content: [text(block, marker(TAIL_TTL))] },
      ],
    };

    const map = parseCacheBreakpoints(
      request,
      summary({ cacheReadInputTokens: 500, cacheCreationInputTokens: 500 }),
    );

    expect(map?.estimatedPrefixTokens).toBe(1000);
  });

  test("classifies segments as unknown when no cache counters are reported", () => {
    const map = parseCacheBreakpoints(
      fourBreakpointRequest(),
      summary({ cacheReadInputTokens: null, cacheCreationInputTokens: null }),
    );

    expect(map?.segments.every((segment) => segment.status === "unknown")).toBe(
      true,
    );
  });

  test("returns an empty segment list when caching is disabled", () => {
    const request = {
      model: "claude-sonnet-4",
      system: [text("You are a helpful assistant.")],
      messages: [{ role: "user", content: [text("hi")] }],
    };

    const map = parseCacheBreakpoints(request, summary({}));

    expect(map).not.toBeNull();
    expect(map?.segments).toEqual([]);
  });

  test("keeps the Tools segment when the marker is not on the final tool", () => {
    const request = {
      model: "claude-sonnet-4",
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: {},
          cache_control: marker(STABLE_TTL),
        },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      ],
      system: [text("You are a helpful assistant.", marker(STABLE_TTL))],
      messages: [{ role: "user", content: [text("hi", marker(TAIL_TTL))] }],
    };

    const map = parseCacheBreakpoints(
      request,
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 10 }),
    );

    expect(map?.segments.map((segment) => segment.label)).toEqual([
      "Tools",
      "System prompt",
      "User message #1",
    ]);
    expect(map?.segments[0].ttl).toBe(STABLE_TTL);
  });

  test("splits a message carrying more than one cache marker", () => {
    const request = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            text("stable prefix block", marker(STABLE_TTL)),
            text("volatile turn-start block", marker(TAIL_TTL)),
          ],
        },
      ],
    };

    const map = parseCacheBreakpoints(
      request,
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 10 }),
    );

    expect(map?.segments.map((segment) => segment.label)).toEqual([
      "User message #1 · block 1",
      "User message #1 · block 2",
    ]);
    expect(map?.segments.map((segment) => segment.ttl)).toEqual([
      STABLE_TTL,
      TAIL_TTL,
    ]);
  });

  test("absorbs a leading string system prompt into the first segment", () => {
    const request = {
      model: "claude-sonnet-4",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: [text("hi", marker(STABLE_TTL))] },
      ],
    };

    const map = parseCacheBreakpoints(
      request,
      summary({ cacheReadInputTokens: 0, cacheCreationInputTokens: 10 }),
    );

    expect(map?.segments).toHaveLength(1);
    expect(map?.segments[0].label).toBe("User message #1");
    expect(map?.segments[0].detail).toContain("System prompt");
  });
});

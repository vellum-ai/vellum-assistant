import { describe, expect, test } from "bun:test";

import {
  estimateContentBlockTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from "../context/token-estimator.js";
import type { Message } from "../providers/types.js";

describe("token estimator", () => {
  test("estimates text tokens from character length", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  test("estimates block types with non-zero overhead", () => {
    expect(
      estimateContentBlockTokens({ type: "text", text: "hello world" }),
    ).toBeGreaterThan(0);
    expect(
      estimateContentBlockTokens({
        type: "tool_use",
        id: "t1",
        name: "bash",
        input: { command: "echo hi" },
      }),
    ).toBeGreaterThan(
      estimateContentBlockTokens({ type: "text", text: "echo hi" }),
    );
    expect(
      estimateContentBlockTokens({
        type: "tool_result",
        tool_use_id: "t1",
        content: "done",
      }),
    ).toBeGreaterThan(
      estimateContentBlockTokens({ type: "text", text: "done" }),
    );
    expect(
      estimateContentBlockTokens({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "a".repeat(100),
        },
      }),
    ).toBeGreaterThan(500);
  });

  test("estimates message and prompt totals", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Please summarize this" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure." },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a.txt" },
          },
        ],
      },
    ];
    const messagesOnly = estimateMessagesTokens(messages);
    const withSystem = estimatePromptTokens(messages, "System prompt");
    expect(estimateMessageTokens(messages[0])).toBeGreaterThan(0);
    expect(messagesOnly).toBeGreaterThan(estimateMessageTokens(messages[0]));
    expect(withSystem).toBeGreaterThan(messagesOnly);
  });

  test("counts file base64 payload for Gemini inline PDF estimation", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.pdf",
      media_type: "application/pdf",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );

    expect(largeFileTokens).toBeGreaterThan(smallFileTokens);
    expect(largeFileTokens - smallFileTokens).toBeGreaterThan(1000);
  });

  test("does not count file base64 payload for OpenAI-style file fallback", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.pdf",
      media_type: "application/pdf",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "openai" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "openai" },
    );

    expect(largeFileTokens).toBe(smallFileTokens);
  });

  test("estimates Anthropic PDF tokens from file size", () => {
    // ~14.8 MB PDF => ~20M base64 chars
    const base64Length = 20_000_000;
    const tokens = estimateContentBlockTokens(
      {
        type: "file",
        source: {
          type: "base64",
          filename: "large-report.pdf",
          media_type: "application/pdf",
          data: "a".repeat(base64Length),
        },
        extracted_text: "",
      },
      { providerName: "anthropic" },
    );

    // Raw bytes = 20_000_000 * 3/4 = 15_000_000
    // Estimated tokens = 15_000_000 * 0.016 = 240_000 (plus overhead)
    expect(tokens).toBeGreaterThan(200_000);
  });

  test("Anthropic PDF minimum is one page", () => {
    const tokens = estimateContentBlockTokens(
      {
        type: "file",
        source: {
          type: "base64",
          filename: "tiny.pdf",
          media_type: "application/pdf",
          data: "a".repeat(16),
        },
        extracted_text: "",
      },
      { providerName: "anthropic" },
    );

    // Should be at least ANTHROPIC_PDF_MIN_TOKENS (1600) plus overhead
    expect(tokens).toBeGreaterThanOrEqual(1600);
  });

  test("does not count non-inline file base64 payload for Gemini", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.txt",
      media_type: "text/plain",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );

    expect(largeFileTokens).toBe(smallFileTokens);
  });

  test("scales image token estimate with base64 payload size", () => {
    const smallImageTokens = estimateContentBlockTokens({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "a".repeat(64) },
    });
    const largeImageTokens = estimateContentBlockTokens({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "a".repeat(60_000),
      },
    });

    expect(largeImageTokens).toBeGreaterThan(smallImageTokens);
    expect(largeImageTokens - smallImageTokens).toBeGreaterThan(1000);
  });
});

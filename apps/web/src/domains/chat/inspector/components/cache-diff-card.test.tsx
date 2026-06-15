/**
 * Tests for the CacheDiffCard prefix-comparison rendering. Renders to
 * static markup (no DOM), mirroring `cache-health-card.test.tsx`, and
 * asserts the status banner copy, the changed-group chips, and the
 * optional line diff for each bust cause. The card calls
 * `useLlmCallDetail` before its early returns, so every render is wrapped
 * in a `QueryClientProvider`; passing the previous call's `requestSections`
 * inline keeps that query disabled (no network) for these unit cases.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CacheDiffCard } from "./cache-diff-card";
import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function system(text: string): LLMContextSection {
  return { kind: "system", label: "System", text };
}

function message(role: string, text: string): LLMContextSection {
  return { kind: "message", label: role, role, text };
}

function settings(data: unknown): LLMContextSection {
  return { kind: "settings", label: "Request settings", data };
}

function entry(
  id: string,
  sections: LLMContextSection[],
  model = "claude-sonnet-4",
): LLMRequestLogEntry {
  return {
    id,
    createdAt: Date.parse("2026-06-13T13:30:00Z"),
    requestPayload: null,
    responsePayload: null,
    summary: { provider: "anthropic", model },
    requestSections: sections,
  };
}

function render(
  current: LLMRequestLogEntry,
  previous: LLMRequestLogEntry | null,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CacheDiffCard
        current={current}
        previous={previous}
        assistantId="assistant-1"
      />
    </QueryClientProvider>,
  );
}

describe("CacheDiffCard", () => {
  test("renders nothing without a previous call", () => {
    const current = entry("call-1", [system("a"), message("user", "hi")]);
    expect(render(current, null)).toBe("");
  });

  test("renders nothing when the current call has no prompt sections", () => {
    const current = entry("call-2", []);
    const previous = entry("call-1", [system("a")]);
    expect(render(current, previous)).toBe("");
  });

  test("names the system prompt as the bust cause and shows a line diff", () => {
    const previous = entry("call-1", [
      system("line one\nold line\nline three"),
      message("user", "hi"),
    ]);
    const current = entry("call-2", [
      system("line one\nnew line\nline three"),
      message("user", "hi"),
    ]);
    const html = render(current, previous);

    expect(html).toContain("System prompt changed");
    expect(html).toContain("System prompt diff");
    expect(html).toContain("new line");
    expect(html).toContain("old line");
  });

  test("flags a model change above other differences", () => {
    const sections = [system("same"), message("user", "hi")];
    const current = entry("call-2", sections, "claude-3-5");
    const previous = entry("call-1", sections, "claude-3-7");
    const html = render(current, previous);

    expect(html).toContain("Model changed");
    expect(html).toContain("claude-3-5");
    expect(html).toContain("claude-3-7");
  });

  test("points at the first divergent message", () => {
    const previous = entry("call-1", [
      system("a"),
      message("user", "hello there"),
      message("assistant", "two"),
    ]);
    const current = entry("call-2", [
      system("a"),
      message("user", "hello world"),
      message("assistant", "two"),
    ]);
    const html = render(current, previous);

    expect(html).toContain("An earlier message changed");
    expect(html).toContain("User message #1");
    expect(html).toContain("user message diff");
  });

  test("reports an unchanged prefix when only messages were appended", () => {
    const previous = entry("call-1", [
      system("a"),
      message("user", "one"),
    ]);
    const current = entry("call-2", [
      system("a"),
      message("user", "one"),
      message("assistant", "two"),
    ]);
    const html = render(current, previous);

    expect(html).toContain("Prompt prefix unchanged");
    expect(html).toContain("Leading messages");
  });

  test("surfaces settings as a low-priority cause", () => {
    const previous = entry("call-1", [
      system("a"),
      message("user", "hi"),
      settings({ temperature: 0 }),
    ]);
    const current = entry("call-2", [
      system("a"),
      message("user", "hi"),
      settings({ temperature: 1 }),
    ]);
    const html = render(current, previous);

    expect(html).toContain("Request settings changed");
  });
});

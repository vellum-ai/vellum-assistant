/**
 * Smoke tests for `CallRail`.
 *
 * The repo doesn't have @testing-library/react wired up, so we use
 * `renderToStaticMarkup` and assert on the resulting HTML string (same
 * pattern as `ChatAvatar.test.tsx` and friends).
 *
 * Two behaviors under test:
 *   - Newest-first ordering with `Call N` labels tracking display
 *     position so the topmost row is `Call 1` (ATL-500, May 10).
 *   - Each row is a real `<a>` anchor with an href produced by
 *     `buildCallHref`, and the currently selected row carries
 *     `aria-current="page"` (ATL-504).
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LLMRequestLogEntry } from "@/domains/chat/lib/inspector-types.js";

import { CallRail } from "@/components/app/assistant/message-inspector/call-rail.js";

function makeLog(
  id: string,
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id,
    createdAt: 1_715_200_000_000,
    requestPayload: null,
    responsePayload: null,
    summary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    requestSections: [],
    responseSections: [],
    ...overrides,
  };
}

describe("CallRail", () => {
  test("renders newest-first with Call labels tracking display position", () => {
    const logs = [
      makeLog("oldest", { createdAt: 1_700_000_000_000 }),
      makeLog("middle", { createdAt: 1_700_000_001_000 }),
      makeLog("newest", { createdAt: 1_700_000_002_000 }),
    ];

    const html = renderToStaticMarkup(
      createElement(CallRail, {
        logs,
        selectedLogId: undefined,
        buildCallHref: (id) => `/inspect?callId=${id}`,
      }),
    );

    const firstPos = html.indexOf("Call 1");
    const secondPos = html.indexOf("Call 2");
    const thirdPos = html.indexOf("Call 3");

    expect(firstPos).toBeGreaterThan(-1);
    expect(secondPos).toBeGreaterThan(-1);
    expect(thirdPos).toBeGreaterThan(-1);

    // Top row is Call 1 (newest), bottom row is Call 3 (oldest).
    expect(firstPos).toBeLessThan(secondPos);
    expect(secondPos).toBeLessThan(thirdPos);
  });

  test("attaches the Latest pill to the top (newest) row only", () => {
    const logs = [
      makeLog("oldest", { createdAt: 1_700_000_000_000 }),
      makeLog("newest", { createdAt: 1_700_000_001_000 }),
    ];

    const html = renderToStaticMarkup(
      createElement(CallRail, {
        logs,
        selectedLogId: undefined,
        buildCallHref: (id) => `/inspect?callId=${id}`,
      }),
    );

    const latestCount = (html.match(/>Latest</g) ?? []).length;
    expect(latestCount).toBe(1);

    // Latest pill sits on the topmost row, which is Call 1.
    const latestPos = html.indexOf(">Latest<");
    const firstPos = html.indexOf("Call 1");
    const secondPos = html.indexOf("Call 2");
    expect(latestPos).toBeGreaterThan(firstPos);
    expect(latestPos).toBeLessThan(secondPos);
  });

  test("renders each row as a real anchor with the supplied href", () => {
    const logs = [makeLog("a"), makeLog("b"), makeLog("c")];

    const html = renderToStaticMarkup(
      createElement(CallRail, {
        logs,
        selectedLogId: "b",
        buildCallHref: (id) => `/inspect?callId=${id}`,
      }),
    );

    expect(html).toContain('href="/inspect?callId=a"');
    expect(html).toContain('href="/inspect?callId=b"');
    expect(html).toContain('href="/inspect?callId=c"');
  });

  test("marks the selected row with aria-current=page", () => {
    const logs = [makeLog("a"), makeLog("b")];

    const html = renderToStaticMarkup(
      createElement(CallRail, {
        logs,
        selectedLogId: "b",
        buildCallHref: (id) => `/inspect?callId=${id}`,
      }),
    );

    const ariaMatches = html.match(/aria-current="page"/g) ?? [];
    expect(ariaMatches.length).toBe(1);
  });

  test("renders empty-state copy when no logs are provided", () => {
    const html = renderToStaticMarkup(
      createElement(CallRail, {
        logs: [],
        selectedLogId: undefined,
        buildCallHref: () => "#",
      }),
    );

    expect(html).toContain("No LLM calls recorded.");
    expect(html).not.toContain("<a ");
  });
});

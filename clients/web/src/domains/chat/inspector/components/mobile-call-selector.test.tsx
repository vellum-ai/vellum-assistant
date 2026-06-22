/**
 * Tests for the mobile-only call selector that replaces the desktop
 * `<aside>` rail on narrow viewports.
 *
 * The selector wraps `CallRail` in a `BottomSheet`. In its closed state
 * (the initial render) only the trigger button is in the markup; the
 * sheet's content is portalled and only mounts when the user taps the
 * trigger, so static-markup tests focus on the trigger's display
 * contract.
 *
 * Strategy mirrors `call-rail.test.tsx`: `renderToStaticMarkup` with a
 * `react-router` `Link` stub so the wrapped rail doesn't trip on a
 * missing router context if/when it ends up in the tree.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

mock.module("react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// Imported AFTER the mock so the component picks up the stub.
import { MobileCallSelector } from "./mobile-call-selector";

function makeEntry(
  id: string,
  createdAt: number,
  overrides: Partial<LLMRequestLogEntry> = {},
): LLMRequestLogEntry {
  return {
    id,
    createdAt,
    requestPayload: null,
    responsePayload: null,
    callSite: "mainAgent",
    summary: {
      provider: "anthropic",
      model: "claude-sonnet-4",
    },
    ...overrides,
  };
}

function render(
  logs: LLMRequestLogEntry[],
  selectedLogId: string | undefined,
): string {
  return renderToStaticMarkup(
    <MobileCallSelector
      logs={logs}
      selectedLogId={selectedLogId}
      buildCallHref={(id) => `/conv/test?callId=${id}`}
    />,
  );
}

describe("MobileCallSelector — trigger label", () => {
  test("renders 'Call N of M' when a known call id is selected", () => {
    // `logs` is oldest-first, so the call at index 1 is "Call 2 of 3".
    const html = render(
      [makeEntry("a", 1), makeEntry("b", 2), makeEntry("c", 3)],
      "b",
    );
    expect(html).toContain("Call 2 of 3");
  });

  test("renders the latest call's position when no id is provided", () => {
    // No selection means the inspector page will fall back to the
    // newest call; the selector mirrors that by reporting `Call N of N`
    // only when its `selectedLogId` prop actually matches a log. With
    // an unknown id we expect the total-only fallback so the user is
    // never lied to about which call is selected.
    const html = render([makeEntry("a", 1), makeEntry("b", 2)], undefined);
    expect(html).toContain("2 LLM calls");
    expect(html).not.toContain("Call 0");
  });

  test("falls back to the total-only label when the selected id is stale", () => {
    // Defensive: a `?callId=` in the URL that no longer matches any log
    // shouldn't surface as "Call -1 of N" or similar nonsense.
    const html = render([makeEntry("a", 1)], "missing");
    expect(html).toContain("1 LLM call");
    expect(html).not.toContain("Call ");
  });

  test("renders an accessible name on the trigger button", () => {
    // Screen-reader users need a label that explains the surface this
    // button opens — the visible text alone ("Call 1 of 1") doesn't.
    const html = render([makeEntry("a", 1)], "a");
    expect(html).toContain('aria-label="Select an LLM call to inspect"');
  });
});

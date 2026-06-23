/**
 * Tests for `WebFetchDetailView` and its `parseWebFetchResult` parser — the
 * nested detail shown when a subagent `web_fetch` pill is clicked. Covers
 * header parsing (url/status/notices), `<external_content>` stripping, the
 * source card + notices + content render, the "View raw" toggle, and the
 * error-result fallback.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

// Render the extracted markdown as plain text so assertions can read it back
// without depending on the markdown renderer's element splitting.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

import {
  hostnameOf,
  parseWebFetchResult,
  WebFetchDetailView,
} from "@/domains/chat/components/web-fetch/web-fetch-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
});
afterAll(() => {
  mock.restore();
});

const CNBC_RESULT = `Requested URL: https://www.cnbc.com/2025/09/22/michelob.html
Final URL: https://www.cnbc.com/2025/09/22/michelob.html
Status: 200 OK
Content-Type: text/html; charset=utf-8
Fetched Bytes: 757146
Character Window: 0-5047 of 5047
Mode: extracted
Notices:
- Extracted only 5047 chars of text from 757146 bytes of HTML (0.7%). Content may be JavaScript-rendered.

Content:
<external_content source="web" origin="https://www.cnbc.com/2025/09/22/michelob.html">
Michelob Ultra has overtaken Modelo Especial as the best-selling beer in the United States.
</external_content>`;

function payload(overrides: Partial<ToolDetailPayload>): ToolDetailPayload {
  return {
    toolCallId: "tu-wf",
    toolName: "web_fetch",
    title: "Fetching",
    activity: "",
    input: { url: "https://www.cnbc.com/2025/09/22/michelob.html" },
    status: "completed",
    kind: "tool",
    result: CNBC_RESULT,
    ...overrides,
  };
}

describe("parseWebFetchResult", () => {
  test("splits header metadata from the extracted body", () => {
    const parsed = parseWebFetchResult(CNBC_RESULT);
    expect(parsed.url).toBe("https://www.cnbc.com/2025/09/22/michelob.html");
    expect(parsed.status).toBe("200 OK");
    expect(parsed.notices.length).toBe(1);
    expect(parsed.notices[0].startsWith("Extracted only 5047 chars")).toBe(true);
    // The <external_content> wrapper is stripped, leaving the prose.
    expect(parsed.content).toBe(
      "Michelob Ultra has overtaken Modelo Especial as the best-selling beer in the United States.",
    );
    expect(parsed.content.includes("<external_content")).toBe(false);
  });

  test("captures a max_chars truncation notice", () => {
    const truncated = CNBC_RESULT.replace(
      /Extracted only.*\./,
      "Output truncated by max_chars=8000.",
    );
    expect(parseWebFetchResult(truncated).notices).toContain(
      "Output truncated by max_chars=8000.",
    );
  });

  test("treats a result with no Content marker as all content, using the fallback url", () => {
    const parsed = parseWebFetchResult("just an error string", "https://x.com");
    expect(parsed.content).toBe("just an error string");
    expect(parsed.url).toBe("https://x.com");
    expect(parsed.status).toBeNull();
    expect(parsed.notices).toEqual([]);
  });
});

describe("hostnameOf", () => {
  test("strips the scheme and leading www.", () => {
    expect(hostnameOf("https://www.cnbc.com/a/b")).toBe("cnbc.com");
  });
  test("returns the input unchanged when it is not a url", () => {
    expect(hostnameOf("not a url")).toBe("not a url");
  });
});

describe("WebFetchDetailView", () => {
  test("renders the source host, the notice, and the extracted content", () => {
    const { getByText, getByTestId } = render(
      <WebFetchDetailView detail={payload({})} />,
    );
    expect(getByText("cnbc.com")).toBeDefined();
    expect(getByText("200 OK")).toBeDefined();
    expect(
      getByText("Extracted only 5047 chars of text from 757146 bytes of HTML (0.7%). Content may be JavaScript-rendered."),
    ).toBeDefined();
    expect(getByTestId("markdown").textContent).toContain(
      "Michelob Ultra has overtaken",
    );
  });

  test("'View raw' toggles to the unparsed result", () => {
    const { getByText, queryByTestId, container } = render(
      <WebFetchDetailView detail={payload({})} />,
    );
    // Parsed view first — the raw HTTP header is hidden.
    expect(queryByTestId("markdown")).not.toBeNull();

    fireEvent.click(getByText("View raw"));
    // Raw view shows the header lines; the markdown view is gone.
    expect(queryByTestId("markdown")).toBeNull();
    expect(container.textContent).toContain(
      "Requested URL: https://www.cnbc.com/2025/09/22/michelob.html",
    );
  });

  test("an error result renders verbatim with no source card", () => {
    const { getByText, queryByText } = render(
      <WebFetchDetailView
        detail={payload({ status: "error", result: "fetch failed: 403" })}
      />,
    );
    expect(getByText("fetch failed: 403")).toBeDefined();
    expect(queryByText("cnbc.com")).toBeNull();
  });
});

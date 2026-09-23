/**
 * Tests for `WebFetchDetailView` and its `parseWebFetchResult` parser. Covers
 * the source card and warnings read from `activityMetadata.webFetch`, the
 * header parsing kept for history recorded without it, `<external_content>`
 * stripping, and the running, refused and failed states. The unparsed result
 * is the drawer's Raw output, covered with the drawer.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

// Render the extracted markdown as plain text so assertions can read it back
// without depending on the markdown renderer's element splitting.
mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({
    content,
    assistantId,
  }: {
    content: string;
    assistantId?: string | null;
  }) => (
    <div
      data-testid="markdown"
      data-has-assistant-id={assistantId == null ? "false" : "true"}
    >
      {content}
    </div>
  ),
}));

import {
  hostnameOf,
  parseWebFetchResult,
  WebFetchDetailView,
} from "@/domains/chat/components/web-fetch/web-fetch-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";
import type { WebFetchMetadata } from "@vellumai/assistant-api";

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
    expect(parsed.notices[0].startsWith("Extracted only 5047 chars")).toBe(
      true,
    );
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

/**
 * Render the view the way the registry does: the live `result` and status
 * flags `ToolDetailBody` resolves, with the payload only as the input source.
 */
function renderView(
  detail: ReturnType<typeof payload>,
  webFetch?: WebFetchMetadata,
) {
  return render(
    <WebFetchDetailView
      detail={detail}
      result={detail.result}
      streamedOutput={undefined}
      answeredQuestion={undefined}
      activityMetadata={webFetch ? { webFetch } : undefined}
      isRunning={detail.status === "running"}
      isError={detail.status === "error"}
      isDenied={detail.status === "denied"}
    />,
  );
}

describe("WebFetchDetailView", () => {
  test("renders the source host, the notice, and the extracted content", () => {
    const { getByText, getByTestId } = renderView(payload({}));
    expect(getByText("cnbc.com")).toBeDefined();
    expect(getByText("200 OK")).toBeDefined();
    expect(
      getByText(
        "Extracted only 5047 chars of text from 757146 bytes of HTML (0.7%). Content may be JavaScript-rendered.",
      ),
    ).toBeDefined();
    expect(getByTestId("markdown").textContent).toContain(
      "Michelob Ultra has overtaken",
    );
  });

  test("never gives the fetched page an assistant id to resolve local files with", () => {
    const { getByTestId } = renderView(payload({}));
    // Remote page text is the least-trusted content in the app: without an
    // assistant id a `vellum://workspace/…` reference it smuggles in stays an
    // inert card instead of pulling local workspace bytes into the panel.
    expect(getByTestId("markdown").getAttribute("data-has-assistant-id")).toBe(
      "false",
    );
  });

  test("shows the page readably under Output, with no raw control of its own", () => {
    const { getByText, queryByText, container } = renderView(payload({}));
    expect(getByText("Output")).toBeDefined();
    // The raw HTTP header is the drawer's Raw output, not a swap here.
    expect(container.textContent).not.toContain("Requested URL:");
    expect(queryByText("View raw")).toBeNull();
  });

  test("an error result renders verbatim with no source card", () => {
    const { getByText, queryByText } = renderView(
      payload({ status: "error", result: "fetch failed: 403" }),
    );
    expect(getByText("fetch failed: 403")).toBeDefined();
    expect(queryByText("cnbc.com")).toBeNull();
  });

  test("a refused fetch says it was not approved, not that it failed", () => {
    // The daemon answers a refusal with an error result addressed to the model.
    const refusal =
      'Permission denied. The "web_fetch" tool was not allowed. Do NOT retry this tool call immediately.';
    const { getByText, queryByText } = render(
      <WebFetchDetailView
        detail={payload({ status: "denied", result: refusal })}
        result={refusal}
        streamedOutput={undefined}
        answeredQuestion={undefined}
        activityMetadata={undefined}
        isRunning={false}
        isError
        isDenied
      />,
    );

    expect(
      getByText("This tool call was not approved, so it did not run."),
    ).toBeDefined();
    expect(queryByText(/Do NOT retry/)).toBeNull();
    expect(queryByText("cnbc.com")).toBeNull();
  });

  test("shows a result that lands while the drawer is already open", () => {
    // The drawer opened mid-fetch, so the payload snapshot is still running and
    // empty; the live result is what `ToolDetailBody` resolved since.
    const { getByText, getByTestId } = render(
      <WebFetchDetailView
        detail={payload({ status: "running", result: undefined })}
        result={payload({}).result}
        streamedOutput={undefined}
        answeredQuestion={undefined}
        activityMetadata={undefined}
        isRunning={false}
        isError={false}
        isDenied={false}
      />,
    );

    expect(getByText("cnbc.com")).toBeDefined();
    expect(getByTestId("markdown").textContent).toContain(
      "Michelob Ultra has overtaken",
    );
  });

  describe("with the daemon's metadata", () => {
    const META: WebFetchMetadata = {
      url: "https://cnbc.com/michelob",
      finalUrl: "https://www.cnbc.com/2025/09/22/michelob.html",
      provider: "default",
      status: 200,
      byteCount: 757146,
      charCount: 5047,
      truncated: false,
      title: "Michelob Ultra is now America's top beer",
      domain: "www.cnbc.com",
      faviconUrl: "https://favicons.example/cnbc.png",
      redirectCount: 1,
      durationMs: 820,
      startIndexPastEnd: false,
    };

    test("the source card shows the page's title, final url, status and favicon", () => {
      const { getByText, getByTestId, container } = renderView(
        payload({}),
        META,
      );
      expect(
        getByText("Michelob Ultra is now America's top beer"),
      ).toBeDefined();
      expect(
        getByText("https://www.cnbc.com/2025/09/22/michelob.html"),
      ).toBeDefined();
      // The metadata's numeric status, not the header's "200 OK".
      expect(getByText("200")).toBeDefined();
      expect(container.textContent).not.toContain("200 OK");
      expect(
        getByTestId("site-favicon").querySelector("img")?.getAttribute("src"),
      ).toBe("https://favicons.example/cnbc.png");
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "https://www.cnbc.com/2025/09/22/michelob.html",
      );
    });

    test("warns from the metadata's flags, not the header's notices for the model", () => {
      const quiet = renderView(payload({}), META);
      // The header carries a JavaScript notice; the metadata flags none.
      expect(quiet.queryAllByRole("status")).toHaveLength(0);
      quiet.unmount();

      const { getAllByRole, getByText, container } = renderView(payload({}), {
        ...META,
        truncated: true,
        mayRequireJavaScript: true,
      });
      expect(getAllByRole("status")).toHaveLength(2);
      expect(getByText("Only part of this page was read.")).toBeDefined();
      expect(
        getByText(
          "This page may need JavaScript to show everything, so some of it may be missing.",
        ),
      ).toBeDefined();
      expect(container.textContent).not.toContain("Extracted only");
    });

    test("a failed fetch shows its error verbatim under the page it tried", () => {
      const { getByText } = renderView(
        payload({ status: "error", result: "Error: HTTP 404" }),
        { ...META, status: 404, errorMessage: "Error: HTTP 404" },
      );
      expect(getByText("Error: HTTP 404")).toBeDefined();
      expect(getByText("404")).toBeDefined();
    });

    test("metadata from an assistant that predates the full warning set keeps the result's notices", () => {
      // No `startIndexPastEnd`: the writer's remaining warnings are only in
      // the result text, so that text's notices are what the reader sees.
      const { startIndexPastEnd: _omitted, ...older } = META;
      const { getByText } = renderView(payload({}), older);
      expect(
        getByText(
          "Extracted only 5047 chars of text from 757146 bytes of HTML (0.7%). Content may be JavaScript-rendered.",
        ),
      ).toBeDefined();
      // The card still reads the metadata it has.
      expect(
        getByText("Michelob Ultra is now America's top beer"),
      ).toBeDefined();
    });

    test("warns of a start past the end and shows a provider's warning as sent", () => {
      const { getAllByRole, getByText } = renderView(payload({}), {
        ...META,
        startIndexPastEnd: true,
        providerWarning: "The page was served from cache.",
      });
      expect(getAllByRole("status")).toHaveLength(2);
      expect(
        getByText(
          "The fetch started past the end of this page, so nothing was read.",
        ),
      ).toBeDefined();
      expect(getByText("The page was served from cache.")).toBeDefined();
    });

    test("a malformed web url the daemon refused reads as text, not a link", () => {
      const { container } = renderView(
        payload({
          status: "error",
          result: "Error: url is required and must be a valid HTTP(S) URL",
          input: { url: "https://[" },
        }),
        {
          ...META,
          url: "https://[",
          finalUrl: "https://[",
          status: 0,
          title: undefined,
          domain: "",
          faviconUrl: undefined,
          errorMessage:
            "Error: url is required and must be a valid HTTP(S) URL",
        },
      );
      expect(container.querySelector("a")).toBeNull();
    });

    test("an empty title leaves the card named by its domain", () => {
      const { getByText } = renderView(payload({}), { ...META, title: "" });
      expect(getByText("www.cnbc.com")).toBeDefined();
    });

    test("a url the daemon refused reads as text, not a link", () => {
      const { getByText, getAllByText, container } = renderView(
        payload({
          status: "error",
          result: "Error: url must use http or https",
          input: { url: "file:///etc/hosts" },
        }),
        {
          ...META,
          url: "file:///etc/hosts",
          finalUrl: "file:///etc/hosts",
          status: 0,
          title: undefined,
          domain: "",
          faviconUrl: undefined,
          errorMessage: "Error: url must use http or https",
        },
      );
      expect(getByText("Error: url must use http or https")).toBeDefined();
      // Named by the url itself, since it has no title or domain.
      expect(getAllByText("file:///etc/hosts")).toHaveLength(2);
      expect(container.querySelector("a")).toBeNull();
    });

    test("a fetch that got no response shows no status", () => {
      const { queryByText, getByText } = renderView(
        payload({ status: "error", result: "Error: request timed out" }),
        { ...META, status: 0, errorMessage: "Error: request timed out" },
      );
      expect(getByText("Error: request timed out")).toBeDefined();
      expect(queryByText("0")).toBeNull();
    });
  });

  test("a fetch still running says so the way every running tool does", () => {
    const { getByText, getByTestId } = renderView(
      payload({ status: "running", result: undefined }),
    );
    expect(getByTestId("tool-output-notice").textContent).toBe("Running…");
    // The requested url is the only source there is yet.
    expect(getByText("cnbc.com")).toBeDefined();
  });
});

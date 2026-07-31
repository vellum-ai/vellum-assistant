import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Notice } from "./notice";

describe("Notice — error tone icon", () => {
  test("renders TriangleAlert on the error tone", () => {
    const html = renderToStaticMarkup(
      <Notice tone="error">Something went wrong.</Notice>,
    );

    expect(html).toContain("lucide-triangle-alert");
    expect(html).not.toContain("lucide-octagon-x");
  });

  test("TriangleAlert is rendered for error even when title and children are absent", () => {
    const html = renderToStaticMarkup(<Notice tone="error" />);
    expect(html).toContain("lucide-triangle-alert");
  });

  test("icon={null} suppresses the default error TriangleAlert", () => {
    const html = renderToStaticMarkup(
      <Notice tone="error" icon={null}>
        Something went wrong.
      </Notice>,
    );

    expect(html).not.toContain("lucide-triangle-alert");
  });
});

describe("Notice — actions layout", () => {
  test("actions render inside the message column, after the message", () => {
    const html = renderToStaticMarkup(
      <Notice
        tone="warning"
        title="Message not sent."
        actions={<button type="button">Store securely</button>}
      >
        Credentials sent in chat are visible in the transcript.
      </Notice>,
    );

    // Actions never form a side column, which would compete with the message
    // for width. They follow the body inside the same text column, so they
    // start on the text's left edge rather than under the icon.
    const column = html.slice(html.indexOf("min-w-0 flex-1 space-y-1"));
    expect(column).toContain("Store securely");
    expect(column.indexOf("Store securely")).toBeGreaterThan(
      column.indexOf("visible in the transcript"),
    );
  });

  test("the dismiss control is pinned to the corner, out of the wrapping flow", () => {
    const html = renderToStaticMarkup(
      <Notice tone="info" title="Heads up" onDismiss={() => {}}>
        Something to know.
      </Notice>,
    );

    expect(html).toContain("absolute right-2.5 top-2.5");
    // Its lane is reserved so a wrapped actions row never runs under it.
    expect(html).toContain("pr-9");
  });
});


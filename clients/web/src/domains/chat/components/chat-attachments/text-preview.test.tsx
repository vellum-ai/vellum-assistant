import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { TextPreviewBody } from "@/domains/chat/components/chat-attachments/text-preview";

afterEach(() => {
  cleanup();
});

describe("TextPreviewBody", () => {
  test("renders markdown files as formatted document content", () => {
    const { container, queryByText } = render(
      <TextPreviewBody
        text={"# Heading\n\nSome **bold** body."}
        filename="design.md"
        mimeType="text/markdown"
      />,
    );

    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    // The raw markdown source must not leak through as literal text.
    expect(queryByText("# Heading")).toBeNull();
  });

  test("treats .md as markdown even when the mime type is generic", () => {
    const { container } = render(
      <TextPreviewBody
        text={"## Subheading"}
        filename="notes.md"
        mimeType="application/octet-stream"
      />,
    );

    expect(container.querySelector("h2")?.textContent).toBe("Subheading");
  });

  test("renders non-markdown text as verbatim monospace source", () => {
    const source = "const answer = 42;";
    const { container } = render(
      <TextPreviewBody
        text={source}
        filename="snippet.ts"
        mimeType="text/plain"
      />,
    );

    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(source);
    // Source must not be interpreted as markdown.
    expect(container.querySelector("h1")).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  TextPreview,
  TextPreviewBody,
} from "@/domains/chat/components/chat-attachments/text-preview";

/** Build a base64 `data:` URI the way `toDisplayAttachments` does. */
function dataUri(mimeType: string, text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

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

describe("TextPreview", () => {
  test("decodes an inline data: URI in-process and renders it", async () => {
    const { container } = render(
      <TextPreview
        url={dataUri("text/markdown", "# Decoded\n\nfrom a data URI")}
        filename="notes.md"
        mimeType="text/markdown"
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("Decoded"),
    );
  });
});

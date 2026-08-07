import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  MarkdownPreview,
  truncateForDisplay,
} from "@/domains/chat/components/local-file/preview/markdown-preview";

/** The cap the preview renders, mirrored here so the boundary is explicit. */
const CAP = 512 * 1024;

function markdownBlob(text: string): Blob {
  return new Blob([text], { type: "text/markdown" });
}

afterEach(() => {
  cleanup();
});

describe("truncateForDisplay", () => {
  test("markdown under the cap is shown whole", () => {
    const result = truncateForDisplay("a".repeat(CAP - 1));

    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(CAP - 1);
  });

  test("markdown exactly at the cap is still shown whole", () => {
    const result = truncateForDisplay("a".repeat(CAP));

    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(CAP);
  });

  test("one character past the cap is cut and reported", () => {
    const result = truncateForDisplay(`${"a".repeat(CAP)}b`);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(CAP);
    expect(result.text.endsWith("b")).toBe(false);
  });

  test("an empty file is not treated as truncated", () => {
    expect(truncateForDisplay("")).toEqual({ text: "", truncated: false });
  });
});

describe("MarkdownPreview", () => {
  test("renders headings, prose, and lists as formatted markdown", async () => {
    render(
      <MarkdownPreview
        blob={markdownBlob("# Title\n\nSome prose.\n\n- first\n- second\n")}
        filename="notes.md"
      />,
    );

    const heading = await waitFor(() =>
      screen.getByRole("heading", { name: "Title" }),
    );
    expect(heading.tagName).toBe("H1");
    expect(screen.getByText("Some prose.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  test("strips a leading frontmatter block, which is metadata", async () => {
    render(
      <MarkdownPreview
        blob={markdownBlob("---\ntitle: Notes\n---\n\n# Body\n")}
        filename="notes.md"
      />,
    );

    await waitFor(() => expect(screen.getByText("Body")).toBeTruthy());
    expect(screen.queryByText(/title: Notes/)).toBeNull();
  });

  test("nothing is editable", async () => {
    const { container } = render(
      <MarkdownPreview blob={markdownBlob("# Title\n")} filename="notes.md" />,
    );

    await waitFor(() => expect(screen.getByText("Title")).toBeTruthy());
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  test("a capped file says it was truncated", async () => {
    render(
      <MarkdownPreview
        blob={markdownBlob(`# Title\n\n${"x".repeat(CAP)}`)}
        filename="notes.md"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Showing the first 512 KB")).toBeTruthy(),
    );
  });

  test("a file under the cap carries no truncation notice", async () => {
    render(
      <MarkdownPreview blob={markdownBlob("# Title\n")} filename="notes.md" />,
    );

    await waitFor(() => expect(screen.getByText("Title")).toBeTruthy());
    expect(screen.queryByText("Showing the first 512 KB")).toBeNull();
  });
});

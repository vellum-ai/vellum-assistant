import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

import { HomeMarkdownContent } from "./home-markdown-content";

describe("HomeMarkdownContent", () => {
  test("renders literal newline escapes as separate paragraphs", () => {
    render(<HomeMarkdownContent content={"First item.\\n\\nSecond item."} />);

    expect(screen.getByText("First item.")).toBeTruthy();
    expect(screen.getByText("Second item.")).toBeTruthy();
  });
});

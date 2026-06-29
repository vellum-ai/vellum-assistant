import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { CommandOutputView } from "./command-output-view";

afterEach(cleanup);

describe("CommandOutputView", () => {
  test("renders content output through the markdown renderer", () => {
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "file contents here" } },
    ]);
    render(<CommandOutputView content={content} />);
    const out = screen.getByTestId("acp-chat-command-output");
    expect(out.textContent).toContain("file contents here");
    expect(out.querySelector("[data-slot='markdown-message']")).not.toBeNull();
  });

  test("renders a ```console fence as a code block, not literal backticks", () => {
    const text = "```console\n$ ls -la\ntotal 0\n```";
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text } },
    ]);
    render(<CommandOutputView content={content} />);
    const out = screen.getByTestId("acp-chat-command-output");
    expect(out.textContent).not.toContain("```");
    expect(out.textContent).toContain("$ ls -la");
    expect(out.textContent).toContain("total 0");
    expect(out.querySelector("code.language-console")).not.toBeNull();
  });

  test("preserves single newlines in unfenced output as hard line breaks", () => {
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "line1\nline2" } },
    ]);
    render(<CommandOutputView content={content} />);
    const out = screen.getByTestId("acp-chat-command-output");
    expect(out.querySelector("br")).not.toBeNull();
    expect(out.textContent).toContain("line1");
    expect(out.textContent).toContain("line2");
  });
});

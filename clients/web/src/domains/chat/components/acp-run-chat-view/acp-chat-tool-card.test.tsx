import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AcpChatBlock } from "@/domains/chat/acp-run-message-projection";

import { AcpChatToolCard } from "./acp-chat-tool-card";

afterEach(cleanup);

type ToolBlock = Extract<AcpChatBlock, { kind: "tool" }>;

function toolBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: "tool",
    toolCallId: "call-1",
    title: "Read file",
    status: "completed",
    ...overrides,
  };
}

describe("AcpChatToolCard", () => {
  test("renders the kind label in the header", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ toolKind: "read", title: "cat ./README.md" })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Read file")).toBeDefined();
  });

  test("renders an execute command as a full, wrapping body line", () => {
    const command = "git log --oneline | grep something && echo ".repeat(10);
    render(
      <AcpChatToolCard
        block={toolBlock({ toolKind: "execute", title: command })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Run command")).toBeDefined();
    const detail = screen.getByTestId("acp-chat-tool-detail");
    // Full command present in the DOM (not truncated) and set to wrap.
    expect(detail.textContent).toBe(command);
    expect(detail.className).toContain("whitespace-pre-wrap");
    expect(detail.className).toContain("break-words");
    expect(detail.className).not.toContain("truncate");
  });

  test("a read block shows the kind label + path chip with no duplicate title line", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({
          toolKind: "read",
          title: "src/touched.ts",
          locations: [{ path: "src/touched.ts" }],
        })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Read file")).toBeDefined();
    expect(screen.getByTestId("acp-chat-tool-file-ref").textContent).toContain(
      "src/touched.ts",
    );
    expect(screen.queryByTestId("acp-chat-tool-detail")).toBeNull();
  });

  test("a file-op block with no chips falls back to showing its title", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ toolKind: "read", title: "src/foo.ts" })}
        onOpenDiff={() => {}}
      />,
    );
    // No locations/diff → no chip → the title must still surface as the detail.
    expect(screen.getByText("Read file")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-tool-file-ref")).toBeNull();
    expect(screen.getByTestId("acp-chat-tool-detail").textContent).toBe(
      "src/foo.ts",
    );
  });

  test("an unknown kind falls back to the Tool call label and Code icon", () => {
    const { container } = render(
      <AcpChatToolCard
        block={toolBlock({ toolKind: "other", title: "mystery" })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Tool call")).toBeDefined();
    expect(container.querySelector(".lucide-code")).not.toBeNull();
  });

  test("shows the command from rawInput.command as the detail line", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({
          toolKind: "execute",
          title: "fallback title",
          rawInput: { command: "npm test" },
        })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByTestId("acp-chat-tool-detail").textContent).toBe(
      "npm test",
    );
  });

  test("falls back to the title and hides the raw section when rawInput is absent", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ toolKind: "execute", title: "npm test" })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByTestId("acp-chat-tool-detail").textContent).toBe(
      "npm test",
    );
    expect(screen.queryByTestId("acp-chat-tool-raw")).toBeNull();
  });

  test("renders a collapsible raw input/output section that expands to pretty-printed values", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({
          toolKind: "execute",
          rawInput: { command: "npm test" },
          rawOutput: { exitCode: 0, stdout: "ok" },
        })}
        onOpenDiff={() => {}}
      />,
    );
    // Collapsed by default — sub-blocks not yet rendered.
    expect(screen.queryByTestId("acp-chat-tool-raw-input")).toBeNull();
    fireEvent.click(screen.getByTestId("acp-chat-tool-raw-toggle"));
    expect(screen.getByTestId("acp-chat-tool-raw-input").textContent).toContain(
      JSON.stringify({ command: "npm test" }, null, 2),
    );
    expect(
      screen.getByTestId("acp-chat-tool-raw-output").textContent,
    ).toContain(JSON.stringify({ exitCode: 0, stdout: "ok" }, null, 2));
  });

  test("renders the status pill per status", () => {
    const { rerender } = render(
      <AcpChatToolCard block={toolBlock({ status: "running" })} onOpenDiff={() => {}} />,
    );
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByTestId("acp-chat-tool-running")).toBeDefined();

    rerender(
      <AcpChatToolCard block={toolBlock({ status: "completed" })} onOpenDiff={() => {}} />,
    );
    expect(screen.getByText("Completed")).toBeDefined();

    rerender(
      <AcpChatToolCard block={toolBlock({ status: "error" })} onOpenDiff={() => {}} />,
    );
    expect(screen.getByText("Failed")).toBeDefined();
  });

  test("hides the running indicator when not running", () => {
    render(
      <AcpChatToolCard block={toolBlock({ status: "completed" })} onOpenDiff={() => {}} />,
    );
    expect(screen.queryByTestId("acp-chat-tool-running")).toBeNull();
  });

  test("renders inline content output through the markdown renderer", () => {
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "file contents here" } },
    ]);
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={() => {}} />,
    );
    const output = screen.getByTestId("acp-chat-tool-output");
    expect(output.textContent).toContain("file contents here");
    // Routed through ChatMarkdownMessage rather than a raw <pre>.
    expect(output.querySelector("[data-slot='markdown-message']")).not.toBeNull();
  });

  test("renders a ```console fence as a code block, not literal backticks", () => {
    const text = "```console\n$ ls -la\ntotal 0\n```";
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text } },
    ]);
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={() => {}} />,
    );
    const output = screen.getByTestId("acp-chat-tool-output");
    // The fence is parsed into a styled code block — no leaked backticks.
    expect(output.textContent).not.toContain("```console");
    expect(output.textContent).not.toContain("```");
    // The inner command + stdout still render.
    expect(output.textContent).toContain("$ ls -la");
    expect(output.textContent).toContain("total 0");
    expect(output.querySelector("code.language-console")).not.toBeNull();
  });

  test("preserves single newlines in unfenced output as hard line breaks", () => {
    // Unfenced terminal-style output: single newlines must survive as <br>,
    // not collapse into one wrapped paragraph (hardLineBreaks).
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "line1\nline2" } },
    ]);
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={() => {}} />,
    );
    const output = screen.getByTestId("acp-chat-tool-output");
    // The single newline renders as an explicit <br>, keeping the lines apart.
    expect(output.querySelector("br")).not.toBeNull();
    expect(output.textContent).toContain("line1");
    expect(output.textContent).toContain("line2");
  });

  test("renders a file chip per diff and fires onOpenDiff with the tool id + file change", () => {
    const content = JSON.stringify([
      { type: "diff", path: "src/a.ts", oldText: "old", newText: "new" },
    ]);
    const onOpenDiff = mock((_id: string, _fc: { path: string }) => {});
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={onOpenDiff} />,
    );

    const chip = screen.getByTestId("acp-chat-tool-file-chip");
    expect(chip.textContent).toContain("src/a.ts");
    fireEvent.click(chip);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    // The owning tool's id is passed so the viewer can re-derive a live diff.
    expect(onOpenDiff).toHaveBeenCalledWith("call-1", {
      path: "src/a.ts",
      oldText: "old",
      newText: "new",
    });
  });

  test("renders a location-only path as a static ref, not a clickable diff chip", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ locations: [{ path: "src/touched.ts" }] })}
        onOpenDiff={() => {}}
      />,
    );
    // The path still shows, but as a non-interactive ref (no diff to open).
    expect(screen.getByTestId("acp-chat-tool-file-ref").textContent).toContain(
      "src/touched.ts",
    );
    expect(screen.queryByTestId("acp-chat-tool-file-chip")).toBeNull();
  });

  test("renders no chips when there are no file changes", () => {
    render(<AcpChatToolCard block={toolBlock()} onOpenDiff={() => {}} />);
    expect(screen.queryByTestId("acp-chat-tool-file-chip")).toBeNull();
  });

  test("collapses long output behind a toggle", () => {
    const longText = "x".repeat(800);
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: longText } },
    ]);
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={() => {}} />,
    );

    expect(screen.queryByTestId("acp-chat-tool-output")).toBeNull();
    const toggle = screen.getByTestId("acp-chat-tool-output-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("acp-chat-tool-output")).toBeDefined();
  });
});

describe("terminal run", () => {
  test("renders a still-running tool as Ended when the run is terminal", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ status: "running" })}
        isTerminal
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Ended")).toBeDefined();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByTestId("acp-chat-tool-running")).toBeNull();
  });

  test("keeps the running spinner while the run is active", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ status: "running" })}
        isTerminal={false}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByTestId("acp-chat-tool-running")).toBeDefined();
  });

  test("does not override an already-terminal tool status", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ status: "completed" })}
        isTerminal
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.queryByText("Ended")).toBeNull();
  });
});

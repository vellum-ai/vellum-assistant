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
  test("renders the tool title", () => {
    render(<AcpChatToolCard block={toolBlock()} onOpenDiff={() => {}} />);
    expect(screen.getByText("Read file")).toBeDefined();
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

  test("renders inline content output in a monospace block", () => {
    const content = JSON.stringify([
      { type: "content", content: { type: "text", text: "file contents here" } },
    ]);
    render(
      <AcpChatToolCard block={toolBlock({ content })} onOpenDiff={() => {}} />,
    );
    const output = screen.getByTestId("acp-chat-tool-output");
    expect(output.textContent).toContain("file contents here");
    expect(output.className).toContain("font-mono");
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

  test("unions path-only locations into chips", () => {
    render(
      <AcpChatToolCard
        block={toolBlock({ locations: [{ path: "src/touched.ts" }] })}
        onOpenDiff={() => {}}
      />,
    );
    expect(screen.getByText("src/touched.ts")).toBeDefined();
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

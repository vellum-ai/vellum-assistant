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

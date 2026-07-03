import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AcpChatThinkingBlock } from "./acp-chat-thinking-block";

afterEach(cleanup);

describe("AcpChatThinkingBlock", () => {
  test("auto-expands and shows a streaming indicator while incomplete", () => {
    render(<AcpChatThinkingBlock content="reasoning" isComplete={false} />);
    expect(screen.getByTestId("acp-chat-thinking-body")).toBeDefined();
    expect(screen.getByTestId("acp-chat-thinking-streaming")).toBeDefined();
    expect(screen.getByText("Thinking")).toBeDefined();
  });

  test("collapses by default once complete", () => {
    render(<AcpChatThinkingBlock content="reasoning" isComplete />);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
    expect(screen.queryByTestId("acp-chat-thinking-streaming")).toBeNull();
    expect(screen.getByText("Thought process")).toBeDefined();
  });

  test("auto-collapses when streaming completes while mounted", () => {
    const { rerender } = render(
      <AcpChatThinkingBlock content="reasoning" isComplete={false} />,
    );
    expect(screen.getByTestId("acp-chat-thinking-body")).toBeDefined();

    rerender(<AcpChatThinkingBlock content="reasoning" isComplete />);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
    expect(screen.getByText("Thought process")).toBeDefined();
  });

  test("persists a manual toggle across an isComplete change", () => {
    const { rerender } = render(
      <AcpChatThinkingBlock content="reasoning" isComplete={false} />,
    );
    const toggle = screen.getByTestId("acp-chat-thinking-toggle");

    // User collapses the block mid-stream.
    fireEvent.click(toggle);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();

    // Streaming completes — the user's collapsed choice must stick.
    rerender(<AcpChatThinkingBlock content="reasoning" isComplete />);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
  });

  test("toggles the body open and closed", () => {
    render(<AcpChatThinkingBlock content="deep thoughts" isComplete />);
    const toggle = screen.getByTestId("acp-chat-thinking-toggle");

    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("acp-chat-thinking-body")).toBeDefined();
    expect(screen.getByText("deep thoughts")).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
  });

  test("renders a static, non-expandable indicator when there's no reasoning text", () => {
    render(<AcpChatThinkingBlock content="" isComplete />);
    // The card still shows (the agent signalled thinking)...
    expect(screen.getByTestId("acp-chat-thinking-block")).toBeDefined();
    expect(screen.getByText("Thought process")).toBeDefined();
    // ...but it is NOT an expandable accordion — no toggle, no body.
    expect(screen.queryByTestId("acp-chat-thinking-toggle")).toBeNull();
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
  });

  test("shows the live indicator for an empty thought signal while streaming", () => {
    render(<AcpChatThinkingBlock content="" isComplete={false} />);
    expect(screen.getByText("Thinking")).toBeDefined();
    expect(screen.getByTestId("acp-chat-thinking-streaming")).toBeDefined();
    expect(screen.queryByTestId("acp-chat-thinking-toggle")).toBeNull();
  });

  test("reflects expanded state via aria-expanded", () => {
    render(<AcpChatThinkingBlock content="x" isComplete />);
    const toggle = screen.getByTestId("acp-chat-thinking-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

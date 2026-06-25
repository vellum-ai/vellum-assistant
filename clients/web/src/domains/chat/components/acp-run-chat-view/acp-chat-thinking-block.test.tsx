import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AcpChatThinkingBlock } from "./acp-chat-thinking-block";

afterEach(cleanup);

describe("AcpChatThinkingBlock", () => {
  test("auto-expands and shows a streaming indicator while incomplete", () => {
    render(<AcpChatThinkingBlock content="reasoning" isComplete={false} />);
    expect(screen.getByTestId("acp-chat-thinking-body")).toBeDefined();
    expect(screen.getByTestId("acp-chat-thinking-streaming")).toBeDefined();
    expect(screen.getByText("Thinking…")).toBeDefined();
  });

  test("collapses by default once complete", () => {
    render(<AcpChatThinkingBlock content="reasoning" isComplete />);
    expect(screen.queryByTestId("acp-chat-thinking-body")).toBeNull();
    expect(screen.queryByTestId("acp-chat-thinking-streaming")).toBeNull();
    expect(screen.getByText("Thought process")).toBeDefined();
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

  test("reflects expanded state via aria-expanded", () => {
    render(<AcpChatThinkingBlock content="x" isComplete />);
    const toggle = screen.getByTestId("acp-chat-thinking-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

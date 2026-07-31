import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AcpChatAgentMessage } from "./acp-chat-agent-message";

afterEach(cleanup);

describe("AcpChatAgentMessage", () => {
  test("renders the message content", () => {
    render(<AcpChatAgentMessage content="Hello world" isComplete />);
    expect(screen.getByText("Hello world")).toBeDefined();
  });

  test("shows a streaming indicator while incomplete", () => {
    render(<AcpChatAgentMessage content="partial" isComplete={false} />);
    expect(screen.getByTestId("acp-chat-agent-streaming")).toBeDefined();
  });

  test("hides the streaming indicator once complete", () => {
    render(<AcpChatAgentMessage content="done" isComplete />);
    expect(screen.queryByTestId("acp-chat-agent-streaming")).toBeNull();
  });

  test("renders left-aligned, full-width, no bubble", () => {
    render(<AcpChatAgentMessage content="x" isComplete />);
    const root = screen.getByTestId("acp-chat-agent-message");
    expect(root.className).toContain("items-start");
    expect(root.className).toContain("w-full");
  });
});

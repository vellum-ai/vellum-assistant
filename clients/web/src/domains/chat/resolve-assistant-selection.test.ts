import { afterEach, describe, expect, test } from "bun:test";

import { isAssistantMessageNode } from "@/domains/chat/resolve-assistant-selection";

function buildMessage(role: string): {
  container: HTMLElement;
  textNode: Node;
  message: HTMLElement;
} {
  const container = document.createElement("div");
  const message = document.createElement("div");
  message.setAttribute("data-message-id", "msg-1");
  message.setAttribute("data-message-role", role);
  const textBlock = document.createElement("div");
  textBlock.setAttribute("data-message-text", "");
  textBlock.textContent = "hello";
  message.appendChild(textBlock);
  container.appendChild(message);
  document.body.appendChild(container);
  return { container, textNode: textBlock.firstChild as Node, message };
}

describe("isAssistantMessageNode", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Mirrors the `selectstart` path, where the selection range is not yet
  // associated: eligibility must come from the node, not the window selection.
  test("is true for a node inside an assistant message", () => {
    const { container, textNode } = buildMessage("assistant");
    expect(isAssistantMessageNode(textNode, container)).toBe(true);
  });

  test("is false for a node inside a user message", () => {
    const { container, textNode } = buildMessage("user");
    expect(isAssistantMessageNode(textNode, container)).toBe(false);
  });

  test("is false for a node outside any message", () => {
    const container = document.createElement("div");
    const stray = document.createElement("span");
    container.appendChild(stray);
    document.body.appendChild(container);
    expect(isAssistantMessageNode(stray, container)).toBe(false);
  });

  test("is false when the message is not inside the container", () => {
    const { message } = buildMessage("assistant");
    const otherContainer = document.createElement("div");
    document.body.appendChild(otherContainer);
    expect(isAssistantMessageNode(message, otherContainer)).toBe(false);
  });

  test("is false for a null node", () => {
    const container = document.createElement("div");
    expect(isAssistantMessageNode(null, container)).toBe(false);
  });
});

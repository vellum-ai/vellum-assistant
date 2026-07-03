import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AcpChatUserTurn } from "./acp-chat-user-turn";

afterEach(cleanup);

describe("AcpChatUserTurn", () => {
  test("renders the content", () => {
    render(<AcpChatUserTurn content="do the thing" />);
    expect(screen.getByText("do the thing")).toBeDefined();
  });

  test("renders right-aligned with a bubble surface", () => {
    render(<AcpChatUserTurn content="hi" />);
    const root = screen.getByTestId("acp-chat-user-turn");
    expect(root.className).toContain("justify-end");

    const bubble = root.firstElementChild as HTMLElement;
    expect(bubble.className).toContain("max-w-[80%]");
    expect(bubble.className).toContain("rounded-lg");
    expect(bubble.className).toContain("bg-[var(--surface-lift)]");
  });
});

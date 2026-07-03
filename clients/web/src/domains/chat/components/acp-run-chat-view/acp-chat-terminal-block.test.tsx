import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AcpChatTerminalBlock } from "./acp-chat-terminal-block";

afterEach(cleanup);

// Fixed epoch; compare against the same local-time formatting the component
// uses so the assertion is locale/timezone-independent.
const COMPLETED_AT = 1700000000000;
const EXPECTED_TIME = new Date(COMPLETED_AT).toLocaleTimeString([], {
  hour: "numeric",
  minute: "2-digit",
});

describe("AcpChatTerminalBlock", () => {
  test("renders nothing for active statuses", () => {
    const { container } = render(
      <AcpChatTerminalBlock status="running" />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("completed + end_turn → Completed", () => {
    render(<AcpChatTerminalBlock status="completed" stopReason="end_turn" />);
    expect(screen.getByText("Completed")).toBeDefined();
    expect(
      screen.getByTestId("acp-chat-terminal-block").getAttribute("data-terminal-kind"),
    ).toBe("completed");
  });

  test("completed with no stopReason → Completed", () => {
    render(<AcpChatTerminalBlock status="completed" />);
    expect(screen.getByText("Completed")).toBeDefined();
  });

  test("completed + max_tokens → Stopped: limit reached", () => {
    render(<AcpChatTerminalBlock status="completed" stopReason="max_tokens" />);
    expect(screen.getByText("Stopped: limit reached")).toBeDefined();
  });

  test("completed + max_turn_requests → Stopped: limit reached", () => {
    render(
      <AcpChatTerminalBlock status="completed" stopReason="max_turn_requests" />,
    );
    expect(screen.getByText("Stopped: limit reached")).toBeDefined();
  });

  test("completed + refusal → Refused", () => {
    render(<AcpChatTerminalBlock status="completed" stopReason="refusal" />);
    expect(screen.getByText("Refused")).toBeDefined();
  });

  test("completed + cancelled → Cancelled", () => {
    render(<AcpChatTerminalBlock status="completed" stopReason="cancelled" />);
    expect(screen.getByText("Cancelled")).toBeDefined();
  });

  test("failed → error styling with the error message", () => {
    render(
      <AcpChatTerminalBlock status="failed" error="boom: connection lost" />,
    );
    const root = screen.getByTestId("acp-chat-terminal-block");
    expect(root.getAttribute("data-terminal-kind")).toBe("failed");
    expect(root.className).toContain("var(--system-negative-strong)");
    expect(screen.getByText("boom: connection lost")).toBeDefined();
  });

  test("failed with no error → fallback copy", () => {
    render(<AcpChatTerminalBlock status="failed" />);
    expect(screen.getByText("Run failed")).toBeDefined();
  });

  test("failed single-line → icon centered on the first line, no mt-0.5", () => {
    render(<AcpChatTerminalBlock status="failed" error="Run failed" />);
    const iconBox = screen.getByTestId("acp-chat-terminal-failed-icon");
    // Fixed line-height flex box (12px) centers the triangle on the text line.
    expect(iconBox.className).toContain("items-center");
    expect(iconBox.className).toContain("h-[12px]");
    // The legacy top-align hack must be gone from both the box and the icon.
    expect(iconBox.className).not.toContain("mt-0.5");
    const icon = iconBox.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toContain("mt-0.5");
  });

  test("failed multi-line → keeps the triangle on the first line", () => {
    render(
      <AcpChatTerminalBlock
        status="failed"
        error={"Run failed on a very long line that wraps across\nmultiple lines"}
      />,
    );
    const root = screen.getByTestId("acp-chat-terminal-block");
    // Row stays top-aligned so the fixed icon box pins to the first line.
    expect(root.className).toContain("items-start");
    expect(
      screen.getByTestId("acp-chat-terminal-failed-icon").className,
    ).toContain("items-center");
  });

  test("cancelled status → Cancelled", () => {
    render(<AcpChatTerminalBlock status="cancelled" />);
    const root = screen.getByTestId("acp-chat-terminal-block");
    expect(root.getAttribute("data-terminal-kind")).toBe("cancelled");
    expect(screen.getByText("Cancelled")).toBeDefined();
  });

  describe("completion time", () => {
    test("completed + completedAt → appends the time", () => {
      render(
        <AcpChatTerminalBlock status="completed" completedAt={COMPLETED_AT} />,
      );
      // Label stays its own node; the time is a sibling suffix.
      expect(screen.getByText("Completed")).toBeDefined();
      expect(screen.getByTestId("acp-chat-terminal-time").textContent).toBe(
        `at ${EXPECTED_TIME}`,
      );
    });

    test("completed without completedAt → no time suffix", () => {
      render(<AcpChatTerminalBlock status="completed" />);
      expect(screen.queryByTestId("acp-chat-terminal-time")).toBeNull();
    });

    test("cancelled status + completedAt → appends the time", () => {
      render(
        <AcpChatTerminalBlock status="cancelled" completedAt={COMPLETED_AT} />,
      );
      expect(screen.getByTestId("acp-chat-terminal-time").textContent).toBe(
        `at ${EXPECTED_TIME}`,
      );
    });
  });
});

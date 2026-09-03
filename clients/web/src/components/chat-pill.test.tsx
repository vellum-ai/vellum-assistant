/**
 * The pill's two shapes: an activatable button and a passive readout. Which
 * one it renders is the whole contract, because a caller that passes `onClick`
 * expects a real button (keyboard reachable, announced as a control) and one
 * that omits it expects an element assistive technology does not offer to
 * press.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ChatPill } from "@/components/chat-pill";

afterEach(() => {
  cleanup();
});

describe("ChatPill", () => {
  test("renders as a button when onClick is provided", () => {
    const { getByRole } = render(
      <ChatPill onClick={() => {}} ariaLabel="Open suggestions">
        Suggestions
      </ChatPill>,
    );
    const button = getByRole("button", { name: "Open suggestions" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
  });

  test("renders a non-interactive element with the caller's role", () => {
    const { getByRole, queryByRole } = render(
      <ChatPill role="status" ariaLive="polite">
        Reconnecting
      </ChatPill>,
    );
    expect(queryByRole("button")).toBeNull();
    expect(getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  test("invokes onClick when the button is activated", () => {
    let clicks = 0;
    const { getByRole } = render(
      <ChatPill
        onClick={() => {
          clicks += 1;
        }}
        ariaLabel="Open suggestions"
      >
        Suggestions
      </ChatPill>,
    );
    fireEvent.click(getByRole("button"));
    expect(clicks).toBe(1);
  });

  test("carries the lifted surface by default", () => {
    const { getByRole } = render(<ChatPill role="status">Default</ChatPill>);
    expect(getByRole("status").className).toContain("bg-[var(--surface-lift)]");
  });

  test("carries the error wash for the negative tone", () => {
    const { getByRole } = render(
      <ChatPill role="status" tone="negative">
        Failed
      </ChatPill>,
    );
    expect(getByRole("status").className).toContain(
      "bg-[var(--system-negative-weak)]",
    );
  });

  /**
   * The chat overlay that hosts the pill is `pointer-events-none` so the
   * transcript stays scrollable underneath it, so the pill has to opt itself
   * back in or it can never be clicked.
   */
  test("stays clickable over a pointer-events-none overlay", () => {
    const { getByRole } = render(
      <ChatPill onClick={() => {}} ariaLabel="Go to newest">
        Newest
      </ChatPill>,
    );
    expect(getByRole("button").className).toContain("pointer-events-auto");
  });

  test("appends the caller's className", () => {
    const { getByRole } = render(
      <ChatPill role="status" className="mb-2">
        Default
      </ChatPill>,
    );
    expect(getByRole("status").className).toContain("mb-2");
  });
});

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

  // The chat overlay these pills float in is `pointer-events-none`, so it does
  // not swallow clicks on the transcript beneath it. A pill inside it has to
  // opt back in or it is visible and dead.
  test("stays clickable over a pointer-events-none overlay", () => {
    let clicks = 0;
    const { getByRole } = render(
      <div className="pointer-events-none">
        <ChatPill
          onClick={() => {
            clicks += 1;
          }}
          ariaLabel="Open suggestions"
        >
          Suggestions
        </ChatPill>
      </div>,
    );
    const button = getByRole("button", { name: "Open suggestions" });
    expect(button.className).toContain("pointer-events-auto");
    fireEvent.click(button);
    expect(clicks).toBe(1);
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
});

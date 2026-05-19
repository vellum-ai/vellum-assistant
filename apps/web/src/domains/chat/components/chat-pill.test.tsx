import { afterEach, describe, expect, it, mock } from "bun:test";

import { cleanup, render, screen } from "@/test-utils.js";

import { ChatPill } from "@/domains/chat/components/chat-pill.js";

describe("ChatPill", () => {
  afterEach(cleanup);

  it("renders as a button when onClick is provided", () => {
    const onClick = mock(() => {});
    render(
      <ChatPill onClick={onClick} ariaLabel="do thing">
        Click me
      </ChatPill>,
    );
    const button = screen.getByRole("button", { name: "do thing" });
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });

  it("renders as a non-interactive element when onClick is omitted", () => {
    render(<ChatPill role="status" ariaLive="polite">Idle</ChatPill>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Idle");
  });

  it("applies the lifted-surface chrome by default", () => {
    render(<ChatPill role="status">Default</ChatPill>);
    const pill = screen.getByRole("status");
    // Shared chrome
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("shadow-md");
    expect(pill.className).toContain("text-label-small-default");
    // Default tone
    expect(pill.className).toContain("bg-[var(--surface-lift)]");
    expect(pill.className).toContain("text-[var(--content-secondary)]");
  });

  it("applies the negative tone for the error variant", () => {
    render(
      <ChatPill role="status" tone="negative">
        Error
      </ChatPill>,
    );
    const pill = screen.getByRole("status");
    // Shared chrome remains
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("shadow-md");
    // Negative tone palette
    expect(pill.className).toContain("bg-[var(--system-negative-weak)]");
    expect(pill.className).toContain("border-[var(--system-negative-strong)]");
  });

  it("applies pointer-events-auto so it stays interactive over a pointer-events-none overlay", () => {
    render(<ChatPill role="status">x</ChatPill>);
    expect(screen.getByRole("status").className).toContain(
      "pointer-events-auto",
    );
  });

  it("invokes onClick when the button variant is activated", () => {
    const onClick = mock(() => {});
    render(
      <ChatPill onClick={onClick} ariaLabel="press">
        Press me
      </ChatPill>,
    );
    screen.getByRole("button", { name: "press" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests for `HeaderStepCarousel` — the animated (title, info) tuple rendered
 * inside a `ToolProgressCardShell`'s collapsed header.
 *
 * Focus: the title-less rendering path. Some tools (e.g. bash) intentionally
 * carry no collapsed-header title; the carousel must then drop both the title
 * element and the leading pipe separator and promote the info subtext into the
 * primary (emphasised) slot. The component seeds its throttle state with the
 * initial value, so the first render shows the supplied tuple synchronously.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";

afterEach(() => {
  cleanup();
});

describe("HeaderStepCarousel — empty title", () => {
  test("drops the title element and the leading pipe, promoting info to the primary slot", () => {
    const { getByText, container } = render(
      <HeaderStepCarousel currentStepTitle="" currentStepInfo="git status" />,
    );

    // Info still renders…
    const info = getByText("git status");
    expect(info).toBeTruthy();
    // …but with no leading pipe separator to its left.
    expect(container.textContent).not.toContain("|");
    // Promoted to the emphasised (primary) colour rather than tertiary subtext.
    expect(info.className).toContain("content-emphasised");
    expect(info.className).not.toContain("content-tertiary");
  });

  test("renders nothing visible when both title and info are empty", () => {
    const { container } = render(
      <HeaderStepCarousel currentStepTitle="" currentStepInfo="" />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("HeaderStepCarousel — with title", () => {
  test("renders the title, a pipe separator, and the info as tertiary subtext", () => {
    const { getByText, container } = render(
      <HeaderStepCarousel currentStepTitle="Reading" currentStepInfo="foo.ts" />,
    );

    expect(getByText("Reading")).toBeTruthy();
    const info = getByText("foo.ts");
    expect(info).toBeTruthy();
    // The pipe separator sits between title and info.
    expect(container.textContent).toContain("|");
    // Info stays de-emphasised subtext when a title is present.
    expect(info.className).toContain("content-tertiary");
    expect(info.className).not.toContain("content-emphasised");
  });
});

/**
 * Tests for `HeaderStepCarousel` — the animated (title, info) tuple rendered
 * inside a `ToolProgressCardShell`'s collapsed header.
 *
 * Focus: which of the two labels renders where, and how each is bounded.
 *
 * Some tools (e.g. bash) intentionally carry no collapsed-header title; the
 * carousel must then drop both the title element and the leading pipe
 * separator and promote the info subtext into the primary (emphasised) slot.
 * Both labels stay bounded in every combination so neither can overflow the
 * header and paint over the trailing step count, with the info giving up its
 * space first.
 *
 * The component seeds its throttle state with the initial value, so the first
 * render shows the supplied tuple synchronously.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";

afterEach(() => {
  cleanup();
});

describe("HeaderStepCarousel — empty title", () => {
  test("drops the title element and the leading divider, promoting info to the primary slot", () => {
    const { getByText, container } = render(
      <HeaderStepCarousel currentStepTitle="" currentStepInfo="git status" />,
    );

    // Info still renders…
    const info = getByText("git status");
    expect(info).toBeTruthy();
    // …but with no leading divider rule to its left.
    expect(container.querySelector(".w-px")).toBeNull();
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
  test("renders the title, a divider rule, and the info as tertiary subtext", () => {
    const { getByText, container } = render(
      <HeaderStepCarousel
        currentStepTitle="Reading"
        currentStepInfo="foo.ts"
      />,
    );

    expect(getByText("Reading")).toBeTruthy();
    const info = getByText("foo.ts");
    expect(info).toBeTruthy();
    // The divider rule sits between title and info.
    expect(container.querySelector(".w-px")).not.toBeNull();
    // Info stays de-emphasised subtext when a title is present.
    expect(info.className).toContain("content-tertiary");
    expect(info.className).not.toContain("content-emphasised");
  });

  test("bounds the title so a long one can't overflow past the trailing controls", () => {
    // Titles are not always short activity verbs: the process-registry rows
    // pass a generated process name (a subagent's task label). A `shrink-0`
    // title would push past the row and paint over the step count, so the
    // title stays bounded (min-w-0 + truncate) even with info beside it.
    const { getByText } = render(
      <HeaderStepCarousel
        currentStepTitle="skillsmith-method-audit"
        currentStepInfo="Working"
      />,
    );

    const title = getByText("skillsmith-method-audit");
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    expect(title.className).not.toContain("shrink-0");
  });

  test("leaves the info the grower so it yields its space before the title", () => {
    // The info's `flex-1` basis of 0 gives it a scaled shrink factor of 0, so
    // an over-long row shrinks the title (which has a real basis) and leaves a
    // short title like "Reading" whole.
    const { getByText } = render(
      <HeaderStepCarousel
        currentStepTitle="Reading"
        currentStepInfo="foo.ts"
      />,
    );

    const info = getByText("foo.ts");
    expect(info.className).toContain("flex-1");
    expect(info.className).toContain("truncate");
    expect(getByText("Reading").className).not.toContain("flex-1");
  });

  test("truncates a title-only label so a long one can't overflow the row", () => {
    const longCommand =
      "cd /Users/me/.local/share/vellum-local/assistants/vellum-faint-asp/workspace &&";
    const { getByText } = render(
      <HeaderStepCarousel currentStepTitle={longCommand} currentStepInfo="" />,
    );

    const title = getByText(longCommand);
    // Title becomes the truncating primary (bounded, min-w-0) instead of a
    // shrink-0/nowrap anchor that would push past the trailing controls.
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    expect(title.className).not.toContain("shrink-0");
  });
});

/**
 * Structural smoke tests for the PreChat ToolSelectionScreen.
 *
 * Same pattern as `PrivacyScreen.test.tsx`: bun test has no DOM renderer,
 * so we render to a static HTML string with `react-dom/server`. Effects
 * are skipped, which is fine — the screen's only effect syncs the
 * `otherText` state into `selectedTools`, exercised separately via
 * the "preserves existing custom entries" test below.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
}));

import { PRECHAT_TOOLS } from "@/lib/onboarding/prechat-tools.js";

import { ToolSelectionScreen } from "@/domains/onboarding/prechat/ToolSelectionScreen.js";

const NOOP = () => {};

describe("ToolSelectionScreen", () => {
  test("renders the off-scale title and subtitle", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toContain("What do you use?");
    expect(html).toContain(
      "This helps me tailor how I assist you. No connections needed",
    );
  });

  test("renders all 12 tool tiles plus a 13th 'Something else' tile", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    for (const tool of PRECHAT_TOOLS) {
      expect(html).toContain(tool.label);
    }
    expect(html).toContain("Something else");
  });

  test("each tool with a logoSrc renders an <img> with that path", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    // `next/image` emits a single <img> per logo with the public path
    // either as the src or encoded into the next/image URL — match
    // either form by checking the bare filename.
    for (const tool of PRECHAT_TOOLS) {
      if (tool.logoSrc === null) continue;
      const filename = tool.logoSrc.split("/").pop()!;
      expect(html).toContain(filename);
    }
  });

  test("Continue is disabled and labeled 'Continue' when nothing is selected", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    // React renders the `disabled` boolean attribute as `disabled=""` in
    // static markup. Use that exact string instead of a `[^>]*disabled`
    // class-string match — the Button primitive's Tailwind classes
    // include literal `disabled:...` utility names that would
    // false-positive a loose regex.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:[^<]|<(?!\/button))*Continue<\/button>/);
  });

  test("Continue is enabled and reads 'Continue · N selected' when tools are picked", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set(["gmail", "slack"])}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toContain("Continue · 2 selected");
    // Asserts the absence of the rendered `disabled=""` attribute on the
    // Continue button — see the comment on the previous test for why we
    // use the literal attribute form instead of a class-string match.
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Continue · 2 selected<\/button>/,
    );
  });

  test("renders a Back button when onBack is provided", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toMatch(/aria-label="Back"/);
  });

  test("does NOT render a Back button when onBack is omitted", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).not.toMatch(/aria-label="Back"/);
  });

  test("renders the OnboardingLayout chrome (creature footer asset)", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set()}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toContain("login-background-characters.svg");
  });

  test("renders the inline 'Something else' expander when initial selectedTools contains other:* entries", () => {
    const html = renderToStaticMarkup(
      <ToolSelectionScreen
        selectedTools={new Set(["other:Trello", "other:Basecamp"])}
        onChange={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    // Helper text shown by the inline Card.
    expect(html).toContain("Separate multiple tools with commas");
  });
});

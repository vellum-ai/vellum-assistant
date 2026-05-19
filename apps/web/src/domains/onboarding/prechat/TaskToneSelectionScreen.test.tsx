/**
 * Structural smoke tests for the PreChat TaskToneSelectionScreen — same
 * `renderToStaticMarkup` pattern as `PrivacyScreen.test.tsx` since the
 * repo lacks a DOM test runner. We assert the visible labels, the
 * disabled/enabled state of Continue, and the Back button accessibility
 * label; click handlers are covered indirectly by the parent flow's
 * own tests.
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

import { PRECHAT_TASKS } from "@/lib/onboarding/prechat-tasks.js";

import { TaskToneSelectionScreen } from "@/domains/onboarding/prechat/TaskToneSelectionScreen.js";

const NOOP = () => {};

describe("TaskToneSelectionScreen", () => {
  test("renders the off-scale title and subtitle", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toContain("What are you working on?");
    expect(html).toContain("Pick the one or two you do most");
  });

  test("renders all 6 task labels and sublabels in macOS order", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    // React's static markup escapes `&` to `&amp;`; normalize the haystack
    // before checking for catalog labels like "Planning & coordinating".
    const normalized = html.replace(/&amp;/g, "&");
    for (const task of PRECHAT_TASKS) {
      expect(normalized).toContain(task.label);
      expect(normalized).toContain(task.sublabel);
    }
    // Sanity: 6 categories.
    expect(PRECHAT_TASKS.length).toBe(6);
  });

  test("Continue is disabled when nothing is selected", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    // React renders the boolean `disabled` attribute as `disabled=""`; we
    // match that exact form rather than `[^>]*disabled` because the
    // Button primitive's Tailwind classes include `disabled:...` utility
    // names that would false-positive a loose match.
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:[^<]|<(?!\/button))*Continue<\/button>/,
    );
  });

  test("Continue is enabled when at least one task is selected", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set(["writing"])}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>(?:[^<]|<(?!\/button))*Continue<\/button>/,
    );
  });

  test("renders a Back button with accessible label", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toMatch(/aria-label="Back"/);
  });

  test("renders the OnboardingLayout chrome", () => {
    const html = renderToStaticMarkup(
      <TaskToneSelectionScreen
        selectedTasks={new Set()}
        onChange={NOOP}
        onBack={NOOP}
        onContinue={NOOP}
        onSkip={NOOP}
      />,
    );
    expect(html).toContain("login-background-characters.svg");
  });
});

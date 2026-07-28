/**
 * Tests for `ToolStepPill`.
 *
 * The non-interactive assertions use `renderToStaticMarkup` (the workspace
 * may lack jsdom — matching the neighboring `risk-badge.test.tsx` /
 * `phase-grouped-step-list.test.tsx` harness). The click test uses
 * `@testing-library/react` + `fireEvent`, the harness existing interactive
 * web tests (e.g. `favicon-chip.test.tsx`) rely on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";

afterEach(() => {
  cleanup();
});

describe("ToolStepPill", () => {
  test("renders the label", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill iconName="sparkle" label="review-cycle" />,
    );
    expect(html).toContain("review-cycle");
    expect(html).toContain('data-testid="tool-step-pill"');
  });

  test("never renders a risk badge (risk lives in the detail drawer)", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill iconName="code" label="bun test" />,
    );
    expect(html).not.toContain('data-testid="risk-badge"');
  });

  test("renders a <button> with an aria-label when onClick is provided", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill iconName="plug" label="linear.createIssue" onClick={() => {}} />,
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="View details: linear.createIssue"');
  });

  test("renders a non-button element when onClick is absent", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill iconName="sparkle" label="review-cycle" />,
    );
    expect(html).not.toContain("<button");
    expect(html).toContain("<span");
  });

  test("marks the pill active when `active` is set", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill
        iconName="sparkle"
        label="review-cycle"
        active
        onClick={() => {}}
      />,
    );
    expect(html).toContain('data-active=""');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("bg-[var(--surface-active)]");
  });

  test("fires onClick when the button is clicked", () => {
    let clicks = 0;
    const { getByTestId } = render(
      <ToolStepPill
        iconName="plug"
        label="linear.createIssue"
        onClick={() => {
          clicks += 1;
        }}
      />,
    );
    fireEvent.click(getByTestId("tool-step-pill"));
    expect(clicks).toBe(1);
  });

  test("renders a <button> when onClick provided and a non-button when not (DOM)", () => {
    const { getByTestId } = render(
      <ToolStepPill iconName="plug" label="clickable" onClick={() => {}} />,
    );
    expect(getByTestId("tool-step-pill").tagName).toBe("BUTTON");

    cleanup();

    const { getByTestId: getStatic } = render(
      <ToolStepPill iconName="sparkle" label="static" />,
    );
    expect(getStatic("tool-step-pill").tagName).not.toBe("BUTTON");
  });

  describe("web variant", () => {
    test("renders an external-link anchor to the url", () => {
      const html = renderToStaticMarkup(
        <ToolStepPill
          variant="web"
          label="Toronto - Wikipedia"
          url="https://en.wikipedia.org/wiki/Toronto"
          domain="en.wikipedia.org"
        />,
      );
      expect(html).toContain('data-testid="tool-step-pill"');
      expect(html).toContain('data-variant="web"');
      expect(html).toContain('href="https://en.wikipedia.org/wiki/Toronto"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain("noopener");
      expect(html).toContain("Toronto - Wikipedia");
    });

    test("renders the favicon img when faviconUrl is set", () => {
      const html = renderToStaticMarkup(
        <ToolStepPill
          variant="web"
          label="Toronto"
          url="https://en.wikipedia.org/wiki/Toronto"
          faviconUrl="https://en.wikipedia.org/favicon.ico"
        />,
      );
      expect(html).toContain('src="https://en.wikipedia.org/favicon.ico"');
    });

    test("falls back to a domain monogram when no favicon", () => {
      const html = renderToStaticMarkup(
        <ToolStepPill
          variant="web"
          label="Toronto - Wikipedia"
          url="https://en.wikipedia.org/wiki/Toronto"
          domain="en.wikipedia.org"
        />,
      );
      // Monogram is the uppercased first letter of the domain.
      expect(html).toContain(">E</span>");
      expect(html).not.toContain("<img");
    });

    test("renders as an <a>, not a button", () => {
      const { getByTestId } = render(
        <ToolStepPill
          variant="web"
          label="Toronto"
          url="https://en.wikipedia.org/wiki/Toronto"
        />,
      );
      expect(getByTestId("tool-step-pill").tagName).toBe("A");
    });
  });
});

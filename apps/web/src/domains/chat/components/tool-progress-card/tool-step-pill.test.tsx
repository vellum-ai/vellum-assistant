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

  test("renders the risk badge when a level is set", () => {
    const html = renderToStaticMarkup(
      <ToolStepPill iconName="code" label="bun test" riskLevel="high" />,
    );
    expect(html).toContain('data-testid="risk-badge"');
    expect(html).toContain('data-risk-level="high"');
    expect(html).toContain("High");
  });

  test("omits the risk badge when no level is set", () => {
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
});

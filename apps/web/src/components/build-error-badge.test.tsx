import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BuildErrorBadge } from "@/components/app-viewer-container";

afterEach(() => {
  cleanup();
});

describe("BuildErrorBadge", () => {
  test("renders the last-working-version message", () => {
    const html = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["TS2322: type error"]} />,
    );
    expect(html).toContain("Build error");
    expect(html).toContain("showing last working version");
  });

  test("is overlaid and non-blocking so it never hides the iframe", () => {
    // The container is absolutely positioned and pointer-events-none, so the
    // last-good preview iframe behind it stays fully visible and interactive.
    const html = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["boom"]} />,
    );
    expect(html).toContain("absolute");
    expect(html).toContain("pointer-events-none");
  });

  test("offers a details affordance when buildErrors are present", () => {
    const withErrors = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["boom"]} />,
    );
    expect(withErrors).toContain("Details");

    const withoutErrors = renderToStaticMarkup(<BuildErrorBadge />);
    expect(withoutErrors).not.toContain("Details");
  });

  test("re-shows after dismissal when a new, distinct error arrives", () => {
    // The component is NOT remounted between successive `error` events, so a
    // prior dismissal must not hide a later DISTINCT failure.
    const { rerender } = render(<BuildErrorBadge buildErrors={["boom"]} />);
    expect(screen.queryByLabelText("App build error")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Dismiss build error"));
    expect(screen.queryByLabelText("App build error")).toBeNull();

    // A new, distinct build error for the still-mounted badge re-shows it.
    rerender(<BuildErrorBadge buildErrors={["different error"]} />);
    expect(screen.queryByLabelText("App build error")).not.toBeNull();
  });

  test("stays dismissed while the same error persists (no flicker)", () => {
    // A repeated identical `error` event must not undo the user's dismissal.
    const { rerender } = render(<BuildErrorBadge buildErrors={["boom"]} />);
    fireEvent.click(screen.getByLabelText("Dismiss build error"));
    expect(screen.queryByLabelText("App build error")).toBeNull();

    rerender(<BuildErrorBadge buildErrors={["boom"]} />);
    expect(screen.queryByLabelText("App build error")).toBeNull();
  });
});

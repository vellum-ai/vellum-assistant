/**
 * Regression tests for the inspector copy button. `Button` takes the icon
 * element itself via `iconOnly`; a bare boolean there renders an empty,
 * invisible button, so these tests pin that a real icon reaches the markup.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CopyButton } from "./copy-button";

describe("CopyButton", () => {
  test("renders a visible icon and the accessible label", () => {
    const html = renderToStaticMarkup(
      <CopyButton text="payload" ariaLabel="Copy request payload" />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Copy request payload"');
  });

  test("applies the caller's positioning className", () => {
    const html = renderToStaticMarkup(
      <CopyButton text="x" ariaLabel="Copy" className="absolute right-2 top-3" />,
    );
    expect(html).toContain("absolute right-2 top-3");
  });
});

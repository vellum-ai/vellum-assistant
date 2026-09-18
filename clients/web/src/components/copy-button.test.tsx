/**
 * Regression tests for the shared copy button. `Button` takes the icon
 * element itself via `iconOnly`; a bare boolean there renders an empty,
 * invisible button, so these tests pin that a real icon reaches the markup.
 */

import { describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
      <CopyButton
        text="x"
        ariaLabel="Copy"
        className="absolute right-2 top-3"
      />,
    );
    expect(html).toContain("absolute right-2 top-3");
  });

  test("builds text given as a function only when pressed", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const build = mock(() => "built on demand");
    const { getByLabelText } = render(
      <CopyButton text={build} ariaLabel="Copy value" />,
    );

    expect(build).not.toHaveBeenCalled();
    fireEvent.click(getByLabelText("Copy value"));
    await Promise.resolve();
    expect(build).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("built on demand");
    cleanup();
  });
});

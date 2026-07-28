/**
 * Tests for the suggestion icon resolver.
 *
 * No DOM environment — we assert the HTML emitted by `renderToStaticMarkup`.
 * Every known icon key, and the generic fallback for unknown keys, must
 * render an `<svg>` (lucide-react's Sparkles also emits an `<svg>`).
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SuggestionIcon } from "./suggestion-icon";

describe("SuggestionIcon", () => {
  test("renders an <svg> for the gmail key", () => {
    const html = renderToStaticMarkup(<SuggestionIcon iconKey="gmail" />);
    expect(html).toContain("<svg");
  });

  test("renders an <svg> for the google-calendar key", () => {
    const html = renderToStaticMarkup(
      <SuggestionIcon iconKey="google-calendar" />,
    );
    expect(html).toContain("<svg");
  });

  test("renders an <svg> for the google-drive key", () => {
    const html = renderToStaticMarkup(<SuggestionIcon iconKey="google-drive" />);
    expect(html).toContain("<svg");
  });

  test("falls back to an <svg> for the generic key", () => {
    const html = renderToStaticMarkup(<SuggestionIcon iconKey="generic" />);
    expect(html).toContain("<svg");
  });
});

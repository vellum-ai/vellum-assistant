import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Notice } from "./notice";

describe("Notice — error tone icon", () => {
  test("renders TriangleAlert (not OctagonX) on the error tone", () => {
    // Regression: the previous default icon was `OctagonX`, which has an X
    // glyph that reads as a close affordance. Users tapped it expecting to
    // dismiss the banner but it was just decorative. TriangleAlert is a
    // warning triangle — unambiguous error indicator with no X glyph.
    const html = renderToStaticMarkup(
      <Notice tone="error">Something went wrong.</Notice>,
    );

    expect(html).toContain("lucide-triangle-alert");
    expect(html).not.toContain("lucide-octagon-x");
  });

  test("TriangleAlert is rendered for error even when title and children are absent", () => {
    const html = renderToStaticMarkup(<Notice tone="error" />);
    expect(html).toContain("lucide-triangle-alert");
  });

  test("explicit icon prop overrides the default error TriangleAlert", () => {
    // Callers can still pass their own icon via the `icon` prop, including
    // an X icon if a banner genuinely is dismissible-as-icon. The default
    // swap only changes the default — it does not lock the surface.
    const html = renderToStaticMarkup(
      <Notice tone="error" icon={null}>
        Something went wrong.
      </Notice>,
    );

    // No default TriangleAlert rendered when `icon={null}` is passed.
    expect(html).not.toContain("lucide-triangle-alert");
  });
});

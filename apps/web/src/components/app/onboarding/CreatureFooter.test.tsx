/**
 * Tests for CreatureFooter.
 *
 * This codebase doesn't have @testing-library/react wired up for DOM tests, so
 * we exercise the component via `renderToStaticMarkup` and assert on the
 * rendered HTML string (same pattern as Tabs.test.tsx).
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CreatureFooter } from "@/components/app/onboarding/CreatureFooter.js";

describe("CreatureFooter", () => {
  test("renders an img element with src pointing at login-background-characters.svg", () => {
    const html = renderToStaticMarkup(<CreatureFooter />);
    // next/image renders an <img> tag in the static markup. We only care that
    // the src attribute references the expected asset path.
    expect(html).toContain("<img");
    expect(html).toMatch(/src="[^"]*login-background-characters\.svg[^"]*"/);
  });

  test("outer container is aria-hidden", () => {
    const html = renderToStaticMarkup(<CreatureFooter />);
    expect(html).toContain('aria-hidden="true"');
  });

  test("applies the className prop to the outer container", () => {
    const html = renderToStaticMarkup(
      <CreatureFooter className="custom-footer-class" />,
    );
    // The outer <div> (which is aria-hidden) should include the passed-in
    // className alongside the component's built-in classes.
    expect(html).toMatch(
      /<div[^>]*aria-hidden="true"[^>]*class="[^"]*custom-footer-class[^"]*"/,
    );
  });
});

/**
 * Tests for the chrome-less `SiteFavicon` primitive.
 *
 * Uses react-testing-library + bun:test so we can fire a real `error` event on
 * the `<img>` to exercise the `useState`-driven monogram fallback. Mirrors the
 * FaviconChip test style — no jest-dom matchers, just className / DOM assertions.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { SiteFavicon } from "@/domains/chat/components/web-search/site-favicon";

afterEach(() => {
  cleanup();
});

describe("SiteFavicon", () => {
  test("renders an <img> with the supplied faviconUrl", () => {
    const { container } = render(
      <SiteFavicon
        faviconUrl="https://example.com/favicon.ico"
        domain="example.com"
        title="Example"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/favicon.ico");
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(img!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("renders the monogram (first letter of domain) when faviconUrl is absent", () => {
    const { container, getByText } = render(
      <SiteFavicon domain="example.com" title="Some Article" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("E")).toBeTruthy();
  });

  test("falls back to the first letter of title when domain is omitted", () => {
    const { getByText } = render(<SiteFavicon title="zenith report" />);
    expect(getByText("Z")).toBeTruthy();
  });

  test("swaps the <img> for the monogram when onError fires", () => {
    const { container, getByText, queryByText } = render(
      <SiteFavicon
        faviconUrl="https://example.com/favicon.ico"
        domain="example.com"
        title="Example"
      />,
    );
    expect(queryByText("E")).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("E")).toBeTruthy();
  });

  test("merges a supplied className onto the outer span", () => {
    const { getByTestId } = render(
      <SiteFavicon title="Example" className="shrink-0" />,
    );
    expect(getByTestId("site-favicon").className).toContain("shrink-0");
  });
});

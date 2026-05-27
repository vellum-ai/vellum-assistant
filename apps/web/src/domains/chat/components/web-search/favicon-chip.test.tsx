/**
 * Tests for the FaviconChip primitive.
 *
 * Uses react-testing-library + bun:test so we can fire a real `error`
 * event on the `<img>` to exercise the `useState`-driven monogram
 * fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip";

afterEach(() => {
  cleanup();
});

describe("FaviconChip — favicon rendering", () => {
  test("renders an <img> with the supplied faviconUrl when provided", () => {
    const { container } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Example"
        domain="example.com"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/favicon.ico");
  });

  test("lazy-loads favicons and sets a no-referrer policy", () => {
    const { container } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Example"
      />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("renders the monogram fallback (and no <img>) when faviconUrl is missing", () => {
    const { container, getByText } = render(
      <FaviconChip title="Example" domain="example.com" />,
    );
    expect(container.querySelector("img")).toBeNull();
    // Monogram derived from domain → "E".
    expect(getByText("E")).toBeTruthy();
  });

  test("renders the monogram fallback when faviconUrl is an empty string", () => {
    const { container, getByText } = render(
      <FaviconChip faviconUrl="" title="Example" domain="example.com" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("E")).toBeTruthy();
  });

  test("swaps to the monogram fallback when the <img> fires onError", () => {
    const { container, getByText, queryByText } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Example"
        domain="example.com"
      />,
    );
    // Before the error: no monogram letter rendered.
    expect(queryByText("E")).toBeNull();
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    // After the error: monogram replaces the (now removed) <img>.
    expect(container.querySelector("img")).toBeNull();
    expect(getByText("E")).toBeTruthy();
  });

  test("resets the failed-image latch when `faviconUrl` prop changes", () => {
    // Simulates the `WebsiteCarousel` rotation case: the same FaviconChip
    // instance receives a new faviconUrl after the previous one errored.
    // Without the reset effect the monogram would stick.
    const { container, rerender } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Example"
        domain="example.com"
      />,
    );
    const firstImg = container.querySelector("img")!;
    fireEvent.error(firstImg);
    // Monogram fallback is showing now.
    expect(container.querySelector("img")).toBeNull();

    // Parent swaps to a fresh URL on the same instance.
    rerender(
      <FaviconChip
        faviconUrl="https://other.example.com/favicon.ico"
        title="Example"
        domain="example.com"
      />,
    );
    const refreshedImg = container.querySelector("img");
    expect(refreshedImg).not.toBeNull();
    expect(refreshedImg!.getAttribute("src")).toBe(
      "https://other.example.com/favicon.ico",
    );
  });
});

describe("FaviconChip — monogram derivation", () => {
  test("uses the first letter of `domain` when provided (uppercased)", () => {
    const { getByText } = render(
      <FaviconChip title="Some Article" domain="acme.io" />,
    );
    expect(getByText("A")).toBeTruthy();
  });

  test("falls back to the first letter of `title` when `domain` is omitted", () => {
    const { getByText } = render(<FaviconChip title="zenith report" />);
    expect(getByText("Z")).toBeTruthy();
  });
});

describe("FaviconChip — title rendering", () => {
  test("renders the title text", () => {
    const { getByText } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Hello world"
      />,
    );
    expect(getByText("Hello world")).toBeTruthy();
  });

  test("applies `truncate` + `max-w-[200px]` to the title (long titles)", () => {
    const longTitle =
      "An extremely long article title that should definitely be truncated by the chip layout to avoid blowing out the row";
    const { getByText } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title={longTitle}
      />,
    );
    const titleEl = getByText(longTitle);
    expect(titleEl.className).toContain("truncate");
    expect(titleEl.className).toContain("max-w-[200px]");
  });
});

describe("FaviconChip — layout tokens", () => {
  test("outer pill uses --surface-base + --radius-pill", () => {
    const { container } = render(
      <FaviconChip title="Example" domain="example.com" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-[var(--surface-base)]");
    expect(root.className).toContain("rounded-[var(--radius-pill)]");
  });

  test("title uses --content-default", () => {
    const { getByText } = render(<FaviconChip title="Example" />);
    const titleEl = getByText("Example");
    expect(titleEl.className).toContain("text-[var(--content-default)]");
  });

  test("favicon slot is 14×14 with --radius-sm and --surface-overlay backdrop", () => {
    const { container } = render(
      <FaviconChip
        faviconUrl="https://example.com/favicon.ico"
        title="Example"
      />,
    );
    const slot = container
      .firstElementChild!.firstElementChild as HTMLElement;
    expect(slot.className).toContain("h-[14px]");
    expect(slot.className).toContain("w-[14px]");
    expect(slot.className).toContain("rounded-[var(--radius-sm)]");
    expect(slot.className).toContain("bg-[var(--surface-overlay)]");
  });
});

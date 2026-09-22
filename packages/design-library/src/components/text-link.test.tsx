/**
 * Tests for the TextLink design library primitive. Renders to static markup
 * and asserts on the emitted HTML.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TextLink, textLinkVariants } from "./text-link";

describe("TextLink", () => {
  test("renders an anchor with its href and the data-slot", () => {
    const html = renderToStaticMarkup(<TextLink href="/docs">Docs</TextLink>);
    expect(html).toMatch(/^<a[^>]*href="\/docs"/);
    expect(html).toContain('data-slot="text-link"');
    expect(html).toContain(">Docs</a>");
  });

  test("default tone wears the link ink and its hover", () => {
    const html = renderToStaticMarkup(<TextLink href="/docs">Docs</TextLink>);
    expect(html).toContain("text-[color:var(--content-link)]");
    expect(html).toContain("hover:text-[color:var(--content-link-hover)]");
  });

  test("quiet tone inherits the surrounding ink and settles to default on hover", () => {
    const html = renderToStaticMarkup(
      <TextLink tone="quiet" href="/docs">
        Docs
      </TextLink>,
    );
    expect(html).toContain("text-[color:inherit]");
    expect(html).toContain("hover:text-[color:var(--content-default)]");
    expect(html).not.toContain("--content-link");
  });

  test("every tone is underlined at rest, never only on hover", () => {
    for (const tone of ["default", "quiet"] as const) {
      const classes = textLinkVariants({ tone }).split(" ");
      expect(classes).toContain("underline");
      expect(classes).not.toContain("hover:underline");
    }
  });

  test("uses the library keyboard focus ring", () => {
    const html = renderToStaticMarkup(<TextLink href="/docs">Docs</TextLink>);
    expect(html).toContain("keyboard-focus:ring-[var(--ring)]");
    expect(html).not.toContain("focus-visible:");
  });

  test("sets no type scale of its own", () => {
    const html = renderToStaticMarkup(<TextLink href="/docs">Docs</TextLink>);
    expect(html).not.toMatch(/text-(body|label|title)-/);
    expect(html).not.toMatch(/\bfont-(medium|semibold|bold)\b/);
  });

  test("asChild puts the look on the caller's element and renders no second anchor", () => {
    const html = renderToStaticMarkup(
      <TextLink asChild tone="quiet">
        <a href="/router" data-testid="router-link">
          Routed
        </a>
      </TextLink>,
    );
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(html).toContain('data-testid="router-link"');
    expect(html).toContain('data-slot="text-link"');
    expect(html).toContain("text-[color:inherit]");
  });

  test("a caller className merges after the variant classes", () => {
    const html = renderToStaticMarkup(
      <TextLink href="/docs" className="underline-offset-2">
        Docs
      </TextLink>,
    );
    expect(html).toContain("underline-offset-2");
    expect(html).toContain("text-[color:var(--content-link)]");
  });

  test("passes anchor attributes through", () => {
    const html = renderToStaticMarkup(
      <TextLink href="https://example.com" target="_blank" rel="noopener noreferrer">
        Out
      </TextLink>,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("no raw hex colors appear in rendered output", () => {
    const html = renderToStaticMarkup(
      <div>
        <TextLink href="/a">A</TextLink>
        <TextLink tone="quiet" href="/b">
          B
        </TextLink>
      </div>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});

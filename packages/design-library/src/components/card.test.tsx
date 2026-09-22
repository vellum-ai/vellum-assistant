/**
 * Tests for Card's interactive and selected states.
 *
 * No DOM environment: `renderToStaticMarkup` output is the contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { Card, CardRoot } from "./card";

const SOURCE = readFileSync(join(import.meta.dir, "card.tsx"), "utf8");

describe("Card", () => {
  test("a plain card has no click-target chrome", () => {
    const html = renderToStaticMarkup(<Card>Body</Card>);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain("bg-[var(--surface-lift)]");
    expect(html).not.toContain("cursor-pointer");
    expect(html).not.toContain("hover:");
    expect(html).not.toContain("data-selected");
  });

  test("surface overlay swaps the resting fill for the overlay token", () => {
    const html = renderToStaticMarkup(<Card surface="overlay">Body</Card>);
    expect(html).toContain("bg-[var(--surface-overlay)]");
    expect(html).not.toContain("bg-[var(--surface-lift)]");
  });

  test("a selected card keeps its tint whatever its surface", () => {
    const html = renderToStaticMarkup(
      <Card surface="overlay" selected>
        Body
      </Card>,
    );
    expect(html).not.toContain("bg-[var(--surface-overlay)]");
    expect(html).toContain("var(--primary-base)_10%");
  });

  test("interactive adds cursor, hover, pressed and the keyboard-focus ring", () => {
    const html = renderToStaticMarkup(<Card interactive>Body</Card>);
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-[var(--surface-base)]");
    expect(html).toContain("active:bg-[var(--surface-active)]");
    expect(html).toContain("keyboard-focus:ring-2");
    expect(html).toContain("keyboard-focus:ring-[var(--ring)]");
  });

  test("interactive adds no role or tab stop of its own", () => {
    const html = renderToStaticMarkup(<Card interactive>Body</Card>);
    expect(html).not.toContain("role=");
    expect(html).not.toContain("tabindex");
  });

  test("interactive + asChild styles the slotted button as the card root", () => {
    const html = renderToStaticMarkup(
      <CardRoot interactive asChild>
        <button type="button">Open</button>
      </CardRoot>,
    );
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("text-left");
    expect(html).not.toContain("<div");
  });

  test("interactive + asChild works around a link", () => {
    const html = renderToStaticMarkup(
      <CardRoot interactive asChild>
        <a href="/somewhere">Open</a>
      </CardRoot>,
    );
    expect(html.startsWith("<a")).toBe(true);
    expect(html).toContain('href="/somewhere"');
    expect(html).toContain("hover:bg-[var(--surface-base)]");
  });

  test("selected swaps the border and fill and sets data-selected", () => {
    const html = renderToStaticMarkup(<Card selected>Body</Card>);
    expect(html).toContain('data-selected=""');
    expect(html).toContain("border-[var(--primary-base)]");
    expect(html).toContain("color-mix(in_srgb,var(--primary-base)_10%,transparent)");
    expect(html).not.toContain("bg-[var(--surface-lift)]");
    expect(html).not.toContain("border-[var(--border-subtle)]");
  });

  test("a selected interactive card holds its tint on hover", () => {
    const html = renderToStaticMarkup(
      <Card interactive selected>
        Body
      </Card>,
    );
    expect(html).toContain("cursor-pointer");
    expect(html).not.toContain("hover:bg-[var(--surface-base)]");
  });

  test("the source uses tokens, never raw hex", () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

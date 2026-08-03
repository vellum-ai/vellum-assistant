/**
 * `/docs/pricing` is public and statically rendered. It documents all
 * available plans: Base (free), Pro packages (Mighty, Super, Ultra), and
 * a Custom configuration. These tests verify that the package names,
 * prices, and Custom plan section are present and that every TOC entry
 * resolves to a real section on the page.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PricingContent } from "@/app/docs/_components/pricing-content";

const PACKAGE_NAMES = ["Mighty", "Super", "Ultra"];

const html = renderToStaticMarkup(<PricingContent />);

/** The fragment targets linked from the "On this page" list. */
function tocTargets(markup: string): string[] {
  const listStart = markup.indexOf("On this page");
  expect(listStart).toBeGreaterThan(-1);
  const list = markup.slice(listStart, markup.indexOf("</ul>", listStart));
  return [...list.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!);
}

describe("PricingContent", () => {
  test("names all three Pro packages", () => {
    for (const name of PACKAGE_NAMES) {
      expect(html).toContain(name);
    }
  });

  test("quotes package prices and credit allowances", () => {
    expect(html).toContain("$30/mo");
    expect(html).toContain("$100/mo");
    expect(html).toContain("$200/mo");
    expect(html).toContain("$25");
    expect(html).toContain("$45");
    expect(html).toContain("$115");
  });

  test("describes the Custom plan with its component tiers", () => {
    expect(html).toContain("Custom");
    expect(html).toContain("$50/mo");
    expect(html).toContain("Medium");
    expect(html).toContain("Large");
    expect(html).toContain("XL");
  });

  test("carries no contents entry for a section that is not on the page", () => {
    const targets = tocTargets(html);
    for (const target of targets) {
      expect(html).toContain(`id="${target}"`);
    }
  });
});

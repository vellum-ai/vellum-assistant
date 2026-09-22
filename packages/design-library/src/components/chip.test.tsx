/**
 * Tests for the Chip primitive.
 *
 * No DOM environment: behavior is verified through `renderToStaticMarkup`
 * (the HTML the component emits) and direct inspection of the class string.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Chip, chipVariants } from "./chip";
import { Tag } from "./tag";

function classOf(html: string): string {
  return /class="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("Chip rendering", () => {
  test("renders a <button type=button> with the chip slot and a label slot", () => {
    const html = renderToStaticMarkup(<Chip>Filter</Chip>);
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-slot="chip"');
    expect(html).toContain('<span data-slot="chip-label"');
    expect(html).toContain(">Filter</span>");
  });

  test("a caller-supplied type wins over the button default", () => {
    const html = renderToStaticMarkup(<Chip type="submit">Go</Chip>);
    expect(html).toContain('type="submit"');
  });

  test("defaults to the neutral tone and applies the requested tone's fill", () => {
    expect(classOf(renderToStaticMarkup(<Chip>x</Chip>))).toContain(
      "bg-[var(--tag-bg-neutral)]",
    );
    const warning = classOf(renderToStaticMarkup(<Chip tone="warning">x</Chip>));
    expect(warning).toContain("bg-[var(--system-mid-weak)]");
    expect(warning).not.toContain("bg-[var(--tag-bg-neutral)]");
  });

  test("shares Tag's geometry and type classes", () => {
    const chip = classOf(renderToStaticMarkup(<Chip tone="info">x</Chip>));
    const tag = classOf(renderToStaticMarkup(<Tag tone="info">x</Tag>));
    for (const cls of tag.split(" ")) {
      expect(chip).toContain(cls);
    }
  });

  test("carries the same keyboard focus ring as Button", () => {
    const cls = classOf(renderToStaticMarkup(<Chip>x</Chip>));
    expect(cls).toContain("keyboard-focus:ring-2");
    expect(cls).toContain("keyboard-focus:ring-[var(--ring)]");
  });

  test("className is merged last so callers can override", () => {
    const cls = classOf(
      renderToStaticMarkup(<Chip className="rounded-full">x</Chip>),
    );
    expect(cls).toContain("rounded-full");
    expect(cls).not.toContain("rounded-[6px]");
  });
});

describe("Chip is an action, not a toggle", () => {
  test("emits no aria-pressed: toggle pills are FilterChip", () => {
    const html = renderToStaticMarkup(<Chip>Action</Chip>);
    expect(html).not.toContain("aria-pressed");
  });

  test("chipVariants is exported and carries the interactive states", () => {
    const cls = chipVariants();
    expect(cls).toContain("cursor-pointer");
    expect(cls).toContain("not-disabled:hover:[--chip-wash:");
    expect(cls).toContain("not-disabled:active:[--chip-wash:");
    expect(cls).toContain("disabled:cursor-not-allowed");
  });
});

describe("Chip icons", () => {
  test("leftIcon takes the tone accent and rightIcon the secondary colour", () => {
    const html = renderToStaticMarkup(
      <Chip
        tone="positive"
        leftIcon={<svg data-testid="left" />}
        rightIcon={<svg data-testid="right" />}
      >
        Label
      </Chip>,
    );
    expect(html).toContain('data-testid="left"');
    expect(html).toContain('data-testid="right"');
    expect(html.indexOf('data-testid="left"')).toBeLessThan(
      html.indexOf("Label"),
    );
    expect(html.indexOf("Label")).toBeLessThan(
      html.indexOf('data-testid="right"'),
    );
    expect(html).toContain("color:var(--system-positive-strong)");
    expect(html).toContain("color:var(--content-secondary)");
  });

  test("icon wrappers are hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<Chip leftIcon={<svg />}>Label</Chip>);
    expect(html).toContain('<span aria-hidden="true"');
  });
});

describe("Chip disabled", () => {
  test("sets the native disabled attribute and the disabled classes", () => {
    const html = renderToStaticMarkup(<Chip disabled>Nope</Chip>);
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(classOf(html)).toContain("disabled:cursor-not-allowed");
  });
});

describe("Chip asChild", () => {
  test("renders the child element with the chip classes and no <button>", () => {
    const html = renderToStaticMarkup(
      <Chip asChild tone="info">
        <a href="/docs">Docs</a>
      </Chip>,
    );
    expect(html.startsWith("<a")).toBe(true);
    expect(html).toContain('href="/docs"');
    expect(html).toContain('data-slot="chip"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("type=");
    expect(classOf(html)).toContain("bg-[var(--system-info-weak)]");
    expect(classOf(html)).toContain("h-6");
  });

  test("with icons, the anchor stays the root and the icons nest inside it", () => {
    // Pins the keyed-array invariant: a Fragment around the Slottable would
    // make Slot clone the Fragment and emit an unstyled <a> beside a bare
    // icon span.
    const html = renderToStaticMarkup(
      <Chip
        asChild
        leftIcon={<svg data-testid="left" />}
        rightIcon={<svg data-testid="right" />}
      >
        <a href="/docs">Docs</a>
      </Chip>,
    );
    expect(html.startsWith("<a")).toBe(true);
    expect(html.endsWith("</a>")).toBe(true);
    expect(html).toMatch(/^<a[^>]*class="[^"]*inline-flex[^"]*"/);
    expect(html.indexOf('data-testid="left"')).toBeLessThan(
      html.indexOf("Docs"),
    );
    expect(html.indexOf("Docs")).toBeLessThan(
      html.indexOf('data-testid="right"'),
    );
    expect(html.indexOf('data-testid="right"')).toBeLessThan(
      html.indexOf("</a>"),
    );
  });

  test("disabled marks the slotted element aria-disabled and untabbable", () => {
    const html = renderToStaticMarkup(
      <Chip asChild disabled>
        <a href="/docs">Docs</a>
      </Chip>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain(' disabled=""');
  });
});

describe("Chip colours", () => {
  test("emits no raw hex colours in any tone or state", () => {
    const html = renderToStaticMarkup(
      <>
        {(["neutral", "positive", "negative", "warning", "info"] as const).map(
          (tone) => (
            <Chip key={tone} tone={tone} leftIcon={<svg />}>
              {tone}
            </Chip>
          ),
        )}
        <Chip disabled>disabled</Chip>
      </>,
    );
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

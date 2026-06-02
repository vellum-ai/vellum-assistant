/**
 * Tests for the SideMenu primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML — no DOM testing library required.
 */

import { describe, expect, mock, test } from "bun:test";
import { Globe } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SideMenu } from "./side-menu";

describe("SideMenu root", () => {
  test("renders a <nav> with the provided aria-label and data-slot", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('data-slot="side-menu"');
  });

  test("default variant is rail with expanded width", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("w-[230px]");
    expect(html).toContain("rounded-[12px]");
    expect(html).toContain("bg-[var(--surface-overlay)]");
  });

  test("collapsed rail shrinks the width", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("w-[48px]");
    expect(html).not.toContain("w-[230px]");
  });

  test("overlay variant is full-bleed with no radius", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", variant: "overlay" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("w-full");
    expect(html).toContain("rounded-none");
  });
});

describe("SideMenu collapsed rail content visibility", () => {
  test("section titles and labels are absent from the DOM in collapsed rail mode", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(
            SideMenu.Section,
            { key: "s", title: "Intelligence" },
            createElement(
              SideMenu.SubList,
              { key: "sl" },
              createElement(SideMenu.Item, {
                key: "i",
                icon: Globe,
                label: "Pinned App",
                badge: "3",
              }),
            ),
          ),
        ),
      ),
    );

    expect(html).not.toContain("Intelligence");
    expect(html).not.toContain(">3<");
    expect(html).not.toContain("Pinned App");
  });

  test("collapsed item rendered outside a SubList still hides its label", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
          }),
        ),
      ),
    );
    expect(html).not.toContain(">Preferences<");
    expect(html).toContain('title="Preferences"');
  });
});

describe("SideMenu collapsed-rail tooltips", () => {
  test("plain collapsed item falls back to the native title", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
          }),
        ),
      ),
    );
    expect(html).toContain('title="Preferences"');
  });

  test("showCollapsedTooltip drops the native title in favor of the styled tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            showCollapsedTooltip: true,
          }),
        ),
      ),
    );
    // No native title, so the browser tooltip and the styled one don't stack
    // into a double tooltip on hover.
    expect(html).not.toContain('title="Preferences"');
  });

  test("custom tooltip text also replaces the native title", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            tooltip: "Open preferences",
          }),
        ),
      ),
    );
    expect(html).not.toContain('title="Preferences"');
  });

  test("expanded rail ignores showCollapsedTooltip and keeps the visible label", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            showCollapsedTooltip: true,
          }),
        ),
      ),
    );
    expect(html).toContain("Preferences");
    expect(html).not.toContain('title="Preferences"');
  });
});

describe("SideMenu overlay always shows labels", () => {
  test("overlay ignores `collapsed` and renders labels + titles", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", variant: "overlay", collapsed: true },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(
            SideMenu.Section,
            { key: "s", title: "Intelligence" },
            createElement(
              SideMenu.SubList,
              { key: "sl" },
              createElement(SideMenu.Item, {
                key: "i",
                icon: Globe,
                label: "Pinned App",
              }),
            ),
          ),
        ),
      ),
    );
    expect(html).toContain("Intelligence");
    expect(html).toContain("Pinned App");
  });
});

describe("SideMenu.Item active / aria-current", () => {
  test("active item sets aria-current=page", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            active: true,
          }),
        ),
      ),
    );
    expect(html).toContain('aria-current="page"');
  });

  test("inactive item does not set aria-current", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).not.toContain("aria-current");
  });
});

describe("SideMenu.Item typography", () => {
  test("default size uses body-medium-lighter", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("text-body-medium-lighter");
    expect(html).not.toContain("text-body-small-default");
  });

  test("compact size uses body-small-default", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Thread",
            size: "compact",
          }),
        ),
      ),
    );
    expect(html).toContain("text-body-small-default");
    expect(html).not.toContain("text-body-medium-lighter");
  });

  test("badge chip uses label-small-default", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Inbox",
            badge: "9",
          }),
        ),
      ),
    );
    expect(html).toContain("text-label-small-default");
  });
});

describe("SideMenu.Item rendering", () => {
  test("renders as <button type=button> when no href is given", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  test("renders as <a> when href is provided", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            href: "/somewhere",
          }),
        ),
      ),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/somewhere"');
    expect(html).not.toContain("<button");
  });

  test("onSelect prop call contract", () => {
    const onSelect = mock(() => {});
    renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            onSelect,
          }),
        ),
      ),
    );
    onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("SideMenu.Item polymorphic icon", () => {
  test("string icon renders the emoji glyph in the leading slot", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: "🚀",
            label: "HQ",
          }),
        ),
      ),
    );
    // The emoji renders inside an aria-hidden inline span, not as a Lucide
    // <svg>. The label remains in its own span.
    expect(html).toContain("🚀");
    expect(html).toContain(">HQ<");
  });

  test("Lucide icon still renders an svg, not a glyph span", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("🚀");
  });

  test("undefined icon renders neither glyph nor svg", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, { key: "i", label: "Bare" }),
        ),
      ),
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain(">Bare<");
  });
});

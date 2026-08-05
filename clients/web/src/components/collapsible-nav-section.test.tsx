/**
 * Tests for the CollapsibleNavSection component.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML. Radix's interactive behavior is covered by Radix's
 * own test suite.
 */

import { describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Clock } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CollapsibleNavSection } from "./collapsible-nav-section";

function renderSingleSection(opts: {
  value: string;
  label: string;
  trailing?: string;
  defaultValue?: string[];
}) {
  return renderToStaticMarkup(
    createElement(
      CollapsibleNavSection.Root,
      { type: "multiple", defaultValue: opts.defaultValue ?? [] },
      createElement(
        CollapsibleNavSection.Section,
        {
          value: opts.value,
          icon: Clock,
          label: opts.label,
          trailing: opts.trailing
            ? createElement("span", null, opts.trailing)
            : undefined,
        },
        createElement("div", null, "child-content"),
      ),
    ),
  );
}

describe("CollapsibleNavSection", () => {
  test("renders the label and accordion trigger markup", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain("Recents");
    expect(html).toContain("<button");
    expect(html).toContain('data-state="closed"');
  });

  test("renders the section in its open state when value is in defaultValue", () => {
    const html = renderSingleSection({
      value: "recents",
      label: "Recents",
      defaultValue: ["recents"],
    });
    expect(html).toContain('data-state="open"');
    expect(html).toContain("child-content");
  });

  test("renders the trailing slot when provided", () => {
    const html = renderSingleSection({
      value: "pinned",
      label: "Pinned",
      trailing: "4",
    });
    expect(html).toContain("4");
  });

  test("omits the trailing slot when not provided", () => {
    const html = renderSingleSection({ value: "pinned", label: "Pinned" });
    // When no trailing is passed, the trailing wrapper span is not rendered
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(1); // Only the title trigger; the chevron is a span
  });

  test("trailing slot is rendered OUTSIDE the trigger button", () => {
    const html = renderToStaticMarkup(
      createElement(
        CollapsibleNavSection.Root,
        { type: "multiple" },
        createElement(
          CollapsibleNavSection.Section,
          {
            value: "pinned",
            icon: Clock,
            label: "Pinned",
            trailing: createElement("button", { type: "button" }, "action"),
          },
          null,
        ),
      ),
    );
    const triggerClose = html.indexOf("</button>");
    const actionButton = html.indexOf("action");
    expect(triggerClose).toBeGreaterThanOrEqual(0);
    expect(actionButton).toBeGreaterThan(triggerClose);
  });

  test("trigger carries the text-body-medium-lighter typography utility", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain("text-body-medium-lighter");
  });

  // No leading icon: the header's only glyph is the trailing disclosure
  // chevron, whatever `icon` the caller passes.
  test("renders no leading icon, just the trailing chevron", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const svgCount = (html.match(/<\/svg>/g) ?? []).length;
    expect(svgCount).toBe(1);
    expect(html).toContain("lucide-chevron-down");
    expect(html).not.toContain("lucide-clock");
  });

  // Regression: a polish pass once made the title a plain drag-only label,
  // leaving the small chevron as the sole toggle target. The whole title
  // row must be the accordion trigger - click toggles,
  // click-and-hold-and-move drags - and it must be the ONLY trigger:
  // a second Radix trigger for the same item duplicates the trigger id
  // and gives keyboard/screen-reader users two stops per section.
  test("the title is the section's one accessible trigger; the chevron is decorative", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const container = document.createElement("div");
    container.innerHTML = html;

    const title = container.querySelector(
      '[data-slot="collapsible-nav-section-title"]',
    );
    expect(title).not.toBeNull();
    // A real accordion trigger, not a styled lookalike: the button carries
    // Radix's expanded state, which is what wires the click to the toggle.
    expect(title?.tagName).toBe("BUTTON");
    expect(title?.getAttribute("aria-expanded")).toBe("false");

    // Exactly one element announces the expanded state.
    expect(container.querySelectorAll("[aria-expanded]")).toHaveLength(1);

    const chevron = container.querySelector(
      '[data-slot="collapsible-nav-section-chevron"]',
    );
    expect(chevron).toBeDefined();
    expect(chevron?.tagName).not.toBe("BUTTON");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
  });

  // The chevron isn't a trigger, so its toggling goes through the click it
  // forwards to the title - which only a real DOM click can prove.
  test("clicking the chevron toggles the section", () => {
    const { container } = render(
      createElement(
        CollapsibleNavSection.Root,
        { type: "multiple", defaultValue: [] },
        createElement(
          CollapsibleNavSection.Section,
          { value: "recents", label: "Recents" },
          createElement("div", null, "child-content"),
        ),
      ),
    );
    try {
      const chevron = container.querySelector<HTMLElement>(
        '[data-slot="collapsible-nav-section-chevron"]',
      );
      expect(chevron).not.toBeNull();

      act(() => {
        chevron?.click();
      });
      expect(
        container
          .querySelector('[data-slot="collapsible-nav-section-title"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(container.textContent).toContain("child-content");

      act(() => {
        chevron?.click();
      });
      expect(
        container
          .querySelector('[data-slot="collapsible-nav-section-title"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      cleanup();
    }
  });

  // The chevron reveals only on hover (or focus-visible, natively via the
  // button itself), not just because the section is expanded. A quiet
  // resting row stays quiet even when open.
  test("the chevron stays hidden at rest even while the section is expanded", () => {
    const html = renderSingleSection({
      value: "recents",
      label: "Recents",
      defaultValue: ["recents"],
    });
    const container = document.createElement("div");
    container.innerHTML = html;

    const item = container.querySelector(
      '[data-slot="collapsible-nav-section-section"]',
    );
    expect(item?.getAttribute("data-state")).toBe("open");

    const chevron = container.querySelector(".lucide-chevron-down");
    expect(chevron?.getAttribute("class")).toContain("opacity-0");
    expect(chevron?.getAttribute("class")).toContain(
      "group-hover/header:opacity-100",
    );
    expect(chevron?.getAttribute("class")).not.toContain(
      "group-data-[state=open]/section:opacity-100",
    );
  });

  test("composes on top of design library Collapsible", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('data-slot="collapsible-nav-section-section"');
  });
});

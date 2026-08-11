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
import { createElement, type ReactNode } from "react";
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

/** The indicator's classes, for the slot compositions that decide them. */
function indicatorClasses(slots: {
  trailing?: ReactNode;
  collapsedIndicator: ReactNode;
}) {
  const html = renderToStaticMarkup(
    createElement(
      CollapsibleNavSection.Root,
      { type: "multiple", defaultValue: [] },
      createElement(
        CollapsibleNavSection.Section,
        {
          value: "pinned",
          label: "Pinned",
          icon: Clock,
          trailing: slots.trailing,
          collapsedIndicator: slots.collapsedIndicator,
        },
        createElement("div", null, "child-content"),
      ),
    ),
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  return (
    container
      .querySelector('[data-slot="collapsible-nav-section-indicator"]')
      ?.getAttribute("class") ?? ""
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

  // Two glyphs: the caller's leading icon and the trailing disclosure
  // chevron. The icon is the section's identity and the collapsed rail draws
  // the same one, so a header that dropped it would put the two surfaces in
  // disagreement.
  test("renders the caller's leading icon alongside the trailing chevron", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const svgCount = (html.match(/<\/svg>/g) ?? []).length;
    expect(svgCount).toBe(2);
    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain("lucide-clock");
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

  /* The chevron is the section's own state, so it shows at rest and rotates
     to report open/closed. The "…" is a control rather than state, so it
     stays hidden until hover. The chevron is outermost, so the "…" reveals
     inside it rather than pushing it around. */
  test("the chevron is visible at rest and rotates when expanded", () => {
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
    const cls = chevron?.getAttribute("class") ?? "";
    expect(cls).not.toContain("opacity-0");
    expect(cls).toContain("group-data-[state=open]/section:rotate-180");

    // The chevron is the outer of the two, so the "…" reveals inside it.
    const controls = container.querySelector(
      '[data-slot="collapsible-nav-section-chevron"]',
    )?.parentElement;
    const slots = Array.from(controls?.children ?? []).map((el) =>
      el.getAttribute("data-slot"),
    );
    expect(slots.at(-1)).toBe("collapsible-nav-section-chevron");
  });

  /* The reveal is keyed on the hover capability it depends on. `hover` is
     independent of viewport width, so a roomy touch surface reports
     `hover: none` at a desktop width, and a control hidden behind a hover the
     device cannot perform is unreachable rather than merely tucked away. */
  test("the trailing control stays visible where the device cannot hover", () => {
    const html = renderSingleSection({
      value: "pinned",
      label: "Pinned",
      trailing: "4",
    });
    expect(html).toContain("[@media(hover:none)]:opacity-100");
    expect(html).toContain(
      "[@media(hover:hover)]:group-hover/header:opacity-100",
    );
  });

  /* The indicator and the trailing control crossfade in one cell, so the
     indicator has to leave under exactly the conditions that bring the
     control in. Where the device cannot hover the control is permanently
     shown, and an indicator that only left on hover would sit underneath it. */
  test("the collapsed indicator yields the cell where there is no hover", () => {
    const cls = indicatorClasses({
      trailing: createElement("button", { type: "button" }, "action"),
      collapsedIndicator: createElement("span", null, "3"),
    });
    expect(cls).toContain("[@media(hover:none)]:opacity-0");
    expect(cls).toContain("[@media(hover:hover)]:group-hover/header:opacity-0");
  });

  /* The trailing control is revealed by focus inside the control itself, so the
     indicator has to yield on the same reading. Keyed on the whole header it
     would also fire on a toggle click, which focuses the title trigger and
     would leave the dot suppressed with the pointer nowhere near the row. */
  test("the indicator yields to focus in the trailing control, not the header", () => {
    const cls = indicatorClasses({
      trailing: createElement("button", { type: "button" }, "action"),
      collapsedIndicator: createElement("span", null, "3"),
    });
    expect(cls).toContain(
      "group-has-[[data-slot=collapsible-nav-section-trailing]:focus-within]/header:opacity-0",
    );
    expect(cls).not.toContain("group-focus-within/header:opacity-0");
  });

  /* The yield exists only to keep two occupants of one cell from painting over
     each other. A section with no trailing control has the cell to itself, and
     an unconditional yield would delete its only header status signal on every
     device that cannot hover. */
  test("the collapsed indicator keeps the cell when there is no trailing control", () => {
    const cls = indicatorClasses({
      collapsedIndicator: createElement("span", null, "3"),
    });
    expect(cls).toContain("opacity-100");
    expect(cls).not.toContain("[@media(hover:none)]:opacity-0");
    expect(cls).not.toContain(
      "[@media(hover:hover)]:group-hover/header:opacity-0",
    );
    expect(cls).not.toContain("group-focus-within/header:opacity-0");
  });

  test("composes on top of design library Collapsible", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('data-slot="collapsible-nav-section-section"');
  });
});

/**
 * `sectionIcon` is the single answer to "what does this section look like",
 * and the collapsed rail renders it, so a header must render the same glyph.
 * A header that drops it puts the two surfaces in disagreement while every
 * call site still reads as correct, since the `icon` prop is passed either
 * way.
 */
describe("CollapsibleNavSection icon", () => {
  /* Collapsed is covered above, by the test that counts both glyphs. The icon
     is a property of the section, not of its open state, so expanded is a
     distinct assertion rather than a restatement. */
  test("renders the icon while expanded, not only while collapsed", () => {
    const html = renderSingleSection({
      value: "s",
      label: "Scheduled",
      defaultValue: ["s"],
    });
    expect(html).toContain('data-slot="collapsible-nav-section-icon"');
  });

  /* Keeps the two assertions above honest: without this, a component that
     emitted the icon slot unconditionally would still pass them. */
  test("renders no icon slot when the section has none", () => {
    const html = renderToStaticMarkup(
      createElement(
        CollapsibleNavSection.Root,
        { type: "multiple", defaultValue: [] },
        createElement(
          CollapsibleNavSection.Section,
          { value: "s", label: "Scheduled" },
          createElement("div", null, "child-content"),
        ),
      ),
    );
    expect(html).not.toContain('data-slot="collapsible-nav-section-icon"');
  });
});

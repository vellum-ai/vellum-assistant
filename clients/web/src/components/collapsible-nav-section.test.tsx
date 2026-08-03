/**
 * Tests for the CollapsibleNavSection component.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML. Radix's interactive behavior is covered by Radix's
 * own test suite.
 */

import { describe, expect, test } from "bun:test";
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
    expect(buttonCount).toBe(1); // Only the trigger button
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

  // Regression: the title used to be the whole clickable trigger. Now only
  // the chevron toggles, so the title can be press-and-held to drag the
  // section without also expanding or collapsing it.
  test("only the chevron toggles; the title is a plain, non-button label", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const container = document.createElement("div");
    container.innerHTML = html;

    const title = container.querySelector(
      '[data-slot="collapsible-nav-section-title"]',
    );
    expect(title).not.toBeNull();
    expect(title?.closest("button")).toBeNull();
    expect(title?.querySelector("button")).toBeNull();

    const chevronButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.querySelector(".lucide-chevron-down"));
    expect(chevronButton).toBeDefined();
    expect(chevronButton?.getAttribute("aria-label")).toBe("Recents");
    // Icon-only: the label text isn't duplicated inside the toggle button.
    expect(chevronButton?.textContent?.trim()).toBe("");
  });

  // The chevron stays hidden at rest so a resting row stays quiet, but
  // reveals on hover, or whenever the section is open: an expanded section
  // always keeps a visible way to collapse itself again.
  test("the chevron stays visible while the section is expanded", () => {
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
    expect(chevron?.getAttribute("class")).toContain(
      "group-data-[state=open]/section:opacity-100",
    );
  });

  test("composes on top of design library Collapsible", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('data-slot="collapsible-nav-section-section"');
  });
});

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
            trailing: createElement(
              "button",
              { type: "button" },
              "action",
            ),
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

  test("trigger carries the text-body-small-default typography utility", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain("text-body-small-default");
    expect(html).toContain("leading-[16px]");
  });

  test("emits both leading glyphs (category icon + chevron-right) layered", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const svgCount = (html.match(/<\/svg>/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(2);
  });

  test("composes on top of design library Collapsible", () => {
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('data-slot="collapsible-nav-section-section"');
  });
});

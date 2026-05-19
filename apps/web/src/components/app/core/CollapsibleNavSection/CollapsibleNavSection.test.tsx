/**
 * Tests for the `CollapsibleNavSection` primitive.
 *
 * The web workspace does not pull in `@testing-library/react` / a DOM
 * environment. Rendering goes through `react-dom/server` so we assert on
 * the emitted markup. That's enough to validate the structural contract
 * — the Radix accordion's interactive behavior is covered by Radix's
 * own test suite.
 */

import { describe, expect, test } from "bun:test";
import { Clock } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CollapsibleNavSection } from "@/components/app/core/CollapsibleNavSection/CollapsibleNavSection.js";

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
    // Radix Accordion.Trigger renders as <button type="button" ...>.
    expect(html).toContain("<button");
    // Header wraps the trigger + trailing slot.
    expect(html).toContain('data-state="closed"');
  });

  test("renders the section in its `open` state when value is in defaultValue", () => {
    const html = renderSingleSection({
      value: "recents",
      label: "Recents",
      defaultValue: ["recents"],
    });
    // Radix emits `data-state="open"` on the trigger + content when the
    // item is open.
    expect(html).toContain('data-state="open"');
    // Content block renders child content in the open state.
    expect(html).toContain("child-content");
  });

  test("renders the `trailing` slot when provided", () => {
    const html = renderSingleSection({
      value: "pinned",
      label: "Pinned",
      trailing: "4",
    });
    // Trailing content appears in the markup outside the trigger button
    // (same flex Header) so the test simply checks for its presence.
    expect(html).toContain("4");
  });

  test("omits the trailing slot entirely when not provided", () => {
    const html = renderSingleSection({ value: "pinned", label: "Pinned" });
    // The trailing wrapper carries the `cns-trailing` marker class —
    // absent from the markup when no `trailing` prop was passed.
    expect(html).not.toContain("cns-trailing");
  });

  test("trailing slot is rendered OUTSIDE the Accordion.Trigger button", () => {
    /**
     * Interactive trailing content (e.g. a menu button) must live
     * outside the Trigger's <button> to avoid invalid nested
     * <button> markup. Assert structurally: the trigger's closing
     * </button> must appear before the trailing wrapper's marker
     * class, proving the trailing sits as a sibling of the Trigger.
     */
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
    const trailingMarker = html.indexOf("cns-trailing");
    expect(triggerClose).toBeGreaterThanOrEqual(0);
    expect(trailingMarker).toBeGreaterThan(triggerClose);
  });

  test("trigger carries the `text-body-small-default` typography utility", () => {
    // The trigger renders at 12/500 (body-small-default) with an
    // explicit `leading-[16px]` override to preserve the nav's 16px
    // rhythm — the canonical variant's line-height is 1.
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    expect(html).toContain("text-body-small-default");
    expect(html).toContain("leading-[16px]");
  });

  test("emits both leading glyphs (category icon + chevron-right) layered", () => {
    // The hover → chevron-right swap is CSS-only; both icons must exist
    // in the DOM so opacity/rotation classes can toggle them.
    const html = renderSingleSection({ value: "recents", label: "Recents" });
    const svgCount = (html.match(/<\/svg>/g) ?? []).length;
    expect(svgCount).toBeGreaterThanOrEqual(2);
  });
});

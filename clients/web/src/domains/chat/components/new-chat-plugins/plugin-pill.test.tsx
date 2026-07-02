/**
 * Tests for the presentational `PluginPill` toggle button. Rendered to static
 * markup (no DOM needed) to assert the accessible label, `aria-pressed` state,
 * and the selected vs unselected token class branches. Click behaviour is
 * covered by invoking the rendered element's `onClick` directly.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginPill } from "./plugin-pill";

describe("PluginPill", () => {
  test("renders the label and an aria-label that offers to enable when unselected", () => {
    const html = renderToStaticMarkup(
      <PluginPill name="simple-memory" selected={false} onToggle={() => {}} />,
    );

    expect(html).toContain("simple-memory");
    expect(html).toContain('aria-label="Enable simple-memory for this chat"');
    expect(html).toContain('aria-pressed="false"');
  });

  test("reflects the selected state in aria-pressed and the disable label", () => {
    const html = renderToStaticMarkup(
      <PluginPill name="simple-memory" selected={true} onToggle={() => {}} />,
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Disable simple-memory for this chat"');
  });

  test("applies the unselected token classes", () => {
    const html = renderToStaticMarkup(
      <PluginPill name="simple-memory" selected={false} onToggle={() => {}} />,
    );

    expect(html).toContain("border-[var(--border-disabled)]");
    expect(html).toContain("bg-[var(--surface-base)]");
    expect(html).toContain("text-[var(--content-secondary)]");
  });

  test("applies the selected token classes", () => {
    const html = renderToStaticMarkup(
      <PluginPill name="simple-memory" selected={true} onToggle={() => {}} />,
    );

    expect(html).toContain("border-[var(--border-active)]");
    expect(html).toContain("bg-[var(--surface-active)]");
    expect(html).toContain("text-[var(--content-default)]");
  });

  test("invokes onToggle when the rendered button is clicked", () => {
    let toggled = 0;
    const element = PluginPill({
      name: "simple-memory",
      selected: false,
      onToggle: () => {
        toggled += 1;
      },
    });

    // The hand-rolled button exposes its click handler directly on props.
    const props = (element as { props: { onClick: () => void } }).props;
    props.onClick();

    expect(toggled).toBe(1);
  });
});

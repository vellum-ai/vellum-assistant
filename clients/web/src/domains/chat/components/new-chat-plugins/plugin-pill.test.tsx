/**
 * Tests for the presentational `PluginPill` toggle button. Asserts the
 * accessible label, `aria-pressed` state, selected vs unselected token class
 * branches, and click behaviour.
 */

import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
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

    // outlined variant (unselected): transparent bg, element border.
    expect(html).toContain("border-[var(--border-element)]");
    expect(html).toContain("bg-transparent");
  });

  test("applies the selected token classes", () => {
    const html = renderToStaticMarkup(
      <PluginPill name="simple-memory" selected={true} onToggle={() => {}} />,
    );

    // outlined + active: primary border, lifted surface.
    expect(html).toContain("border-[var(--primary-base)]");
    expect(html).toContain("bg-[var(--surface-lift)]");
  });

  test("invokes onToggle when the rendered button is clicked", () => {
    let toggled = 0;
    const { getByRole } = render(
      <PluginPill
        name="simple-memory"
        selected={false}
        onToggle={() => {
          toggled += 1;
        }}
      />,
    );

    fireEvent.click(getByRole("button"));

    expect(toggled).toBe(1);
  });
});

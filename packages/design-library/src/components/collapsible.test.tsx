/**
 * Tests for the Collapsible design library primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML. Radix's interactive behavior is covered by Radix's
 * own test suite.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Collapsible } from "./collapsible";

function renderSection(opts: {
  value: string;
  triggerText: string;
  children?: string;
  defaultValue?: string[];
}) {
  return renderToStaticMarkup(
    createElement(
      Collapsible.Root,
      { type: "multiple", defaultValue: opts.defaultValue ?? [] },
      createElement(
        Collapsible.Item,
        { value: opts.value },
        createElement(Collapsible.Trigger, null, opts.triggerText),
        createElement(
          Collapsible.Content,
          null,
          createElement("div", null, opts.children ?? "child-content"),
        ),
      ),
    ),
  );
}

describe("Collapsible", () => {
  test("renders data-slot on root", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain('data-slot="collapsible"');
  });

  test("renders data-slot on item", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain('data-slot="collapsible-item"');
  });

  test("renders data-slot on header", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain('data-slot="collapsible-header"');
  });

  test("renders data-slot on trigger", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain('data-slot="collapsible-trigger"');
  });

  test("renders data-slot on content", () => {
    const html = renderSection({
      value: "a",
      triggerText: "Section A",
      defaultValue: ["a"],
    });
    expect(html).toContain('data-slot="collapsible-content"');
  });

  test("renders trigger text and button markup", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain("Section A");
    expect(html).toContain("<button");
  });

  test("closed state by default", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain('data-state="closed"');
  });

  test("open state when value is in defaultValue", () => {
    const html = renderSection({
      value: "a",
      triggerText: "Section A",
      defaultValue: ["a"],
    });
    expect(html).toContain('data-state="open"');
    expect(html).toContain("child-content");
  });

  test("content has the collapsible-content animation class", () => {
    const html = renderSection({
      value: "a",
      triggerText: "Section A",
      defaultValue: ["a"],
    });
    expect(html).toContain("collapsible-content");
  });

  test("trigger has keyboard-focus ring styles", () => {
    const html = renderSection({ value: "a", triggerText: "Section A" });
    expect(html).toContain("keyboard-focus:ring-2");
  });
});

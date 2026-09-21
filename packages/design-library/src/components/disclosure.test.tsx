/**
 * Tests for the Disclosure design library primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the emitted
 * HTML. Radix's interactive behaviour is covered by Radix's own test suite.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Disclosure } from "./disclosure";

function render(props: Parameters<typeof Disclosure.Root>[0] = {}) {
  return renderToStaticMarkup(
    <Disclosure.Root {...props}>
      <Disclosure.Trigger>Advanced</Disclosure.Trigger>
      <Disclosure.Content className="mt-2">
        <span>region-body</span>
      </Disclosure.Content>
    </Disclosure.Root>,
  );
}

describe("Disclosure", () => {
  test("renders a data-slot per part", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('data-slot="disclosure"');
    expect(html).toContain('data-slot="disclosure-trigger"');
    expect(html).toContain('data-slot="disclosure-content"');
  });

  test("closed by default: the trigger says so and the region is not rendered", () => {
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("region-body");
  });

  test("defaultOpen renders the region and announces it", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("region-body");
  });

  test("controlled open wins over defaultOpen", () => {
    expect(render({ open: false, defaultOpen: true })).not.toContain(
      "region-body",
    );
    expect(render({ open: true })).toContain("region-body");
  });

  test("the trigger points at the region it controls", () => {
    const html = render({ defaultOpen: true });
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeDefined();
    expect(html).toContain(`id="${controls}"`);
  });

  test("the header is not a heading, so a form toggle stays out of the outline", () => {
    const html = render();
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).toContain('data-slot="disclosure-header"');
  });

  test("the trigger is a button with the library focus ring and a chevron", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("keyboard-focus:ring-[var(--ring)]");
    expect(html).toContain("<svg");
    expect(html).toContain("rotate-90");
  });

  test("hideChevron drops the glyph", () => {
    const html = renderToStaticMarkup(
      <Disclosure.Root>
        <Disclosure.Trigger hideChevron>Advanced</Disclosure.Trigger>
      </Disclosure.Root>,
    );
    expect(html).not.toContain("<svg");
  });

  test("size picks the label's type scale", () => {
    const small = render();
    expect(small).toContain("text-body-small-default");
    const medium = renderToStaticMarkup(
      <Disclosure.Root>
        <Disclosure.Trigger size="medium">Advanced</Disclosure.Trigger>
      </Disclosure.Root>,
    );
    expect(medium).toContain("text-body-medium-default");
  });

  test("keepMounted keeps a closed region in the DOM, hidden", () => {
    const html = renderToStaticMarkup(
      <Disclosure.Root>
        <Disclosure.Trigger>Advanced</Disclosure.Trigger>
        <Disclosure.Content keepMounted>
          <span>region-body</span>
        </Disclosure.Content>
      </Disclosure.Root>,
    );
    expect(html).toContain("region-body");
    expect(html).toContain("data-[state=closed]:hidden");
    expect(html).toContain('data-state="closed"');
  });

  test("spacing classes land on the inner box, not the animated element", () => {
    const html = render({ defaultOpen: true });
    expect(html).toMatch(
      /data-slot="disclosure-content"[^>]*class="[^"]*collapsible-content[^"]*"/,
    );
    expect(html).not.toMatch(
      /data-slot="disclosure-content"[^>]*class="[^"]*mt-2/,
    );
    expect(html).toContain('<div class="mt-2">');
  });

  test("disabled blocks the trigger", () => {
    const html = render({ disabled: true });
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  test("asChild hands the trigger to the caller's element", () => {
    const html = renderToStaticMarkup(
      <Disclosure.Root>
        <Disclosure.Trigger asChild>
          <button type="button" data-testid="own">
            Own
          </button>
        </Disclosure.Trigger>
      </Disclosure.Root>,
    );
    expect(html).toContain('data-testid="own"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<svg");
  });

  test("no raw hex colors appear in rendered output", () => {
    expect(render({ defaultOpen: true })).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});

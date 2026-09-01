import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Combobox } from "./combobox";

/**
 * `Combobox.Group`, which is the one part of the combobox that renders
 * without the root's context. Its keyboard and ARIA contract is driven end to
 * end by the `Combobox` and `SearchableSelect` stories, which run in a real
 * browser; what SSR proves is the heading's own wiring and treatment.
 */
describe("Combobox.Group", () => {
  test("names the section it labels", () => {
    const html = renderToStaticMarkup(
      <Combobox.Group label="xAI">
        <span>Grok 4.6</span>
      </Combobox.Group>,
    );
    expect(html).toContain('role="group"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain("xAI");
  });

  test("leaves the heading's own letters alone", () => {
    const html = renderToStaticMarkup(
      <Combobox.Group label="DeepSeek">
        <span>DeepSeek V4 Pro</span>
      </Combobox.Group>,
    );
    // A vendor's name is spelled the way the vendor spells it. A transform on
    // the heading would respell every one of them.
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("capitalize");
  });

  test("pins the heading only where the caller asks for it", () => {
    const loose = renderToStaticMarkup(
      <Combobox.Group label="Anthropic">
        <span>Claude Opus 5</span>
      </Combobox.Group>,
    );
    expect(loose).not.toContain("sticky");

    const pinned = renderToStaticMarkup(
      <Combobox.Group label="Anthropic" stickyLabel>
        <span>Claude Opus 5</span>
      </Combobox.Group>,
    );
    // Opaque and above the rows, or the rows scroll straight through it.
    expect(pinned).toContain("sticky");
    expect(pinned).toContain("top-0");
    expect(pinned).toContain("z-10");
    expect(pinned).toContain("bg-[var(--surface-lift)]");
  });
});

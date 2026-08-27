import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SearchableSelect,
  type SearchableSelectOption,
} from "./searchable-select";

const options: SearchableSelectOption[] = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "gpt-5-6", label: "GPT-5.6" },
  { value: "__custom__", label: "Enter a custom model ID…", sticky: true },
];

function attr(html: string, tag: string, name: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`);
  return re.exec(html)?.[1] ?? null;
}

/**
 * The closed field. Its open behaviour (filtering, the keyboard contract, the
 * pinned row) is driven end to end by the `SearchableSelect` stories, which
 * run in a real browser; what SSR can prove is the wiring that a screen
 * reader depends on before anything is opened.
 */
describe("SearchableSelect", () => {
  test("labels the field it renders above", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        id="model"
        label="Model"
        options={options}
        value="claude-opus-4-8"
        onChange={() => {}}
        emptyText="No matching models"
      />,
    );
    expect(attr(html, "label", "for")).toBe("model");
    expect(attr(html, "label", "id")).toBe("model-label");
    expect(html).toContain('aria-labelledby="model-label"');
  });

  test("declares the combobox role, closed", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        id="model"
        options={options}
        value=""
        onChange={() => {}}
        aria-label="Model"
        placeholder="Select a model"
        emptyText="No matching models"
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-autocomplete="list"');
    // Closed, so there is no listbox to point at.
    expect(html).not.toContain("aria-controls=");
    expect(html).not.toContain('role="listbox"');
  });

  test("shows the selected option's label, not its value", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        options={options}
        value="claude-opus-4-8"
        onChange={() => {}}
        aria-label="Model"
        emptyText="No matching models"
      />,
    );
    expect(attr(html, "input", "value")).toBe("Claude Opus 4.8");
  });

  test("falls back to the placeholder when nothing is chosen", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        options={options}
        value=""
        onChange={() => {}}
        aria-label="Model"
        placeholder="Select a model"
        emptyText="No matching models"
      />,
    );
    expect(attr(html, "input", "value")).toBe("");
    expect(attr(html, "input", "placeholder")).toBe("Select a model");
  });

  test("announces the error and points the field at it", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        id="model"
        label="Model"
        options={options}
        value=""
        onChange={() => {}}
        errorText="Select a model"
        emptyText="No matching models"
      />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="model-error"');
    expect(html).toContain('id="model-error"');
    expect(html).toContain("Select a model");
  });

  test("disables the field rather than leaving it typeable", () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        options={options}
        value="claude-opus-4-8"
        onChange={() => {}}
        aria-label="Model"
        emptyText="No matching models"
        disabled
      />,
    );
    expect(html).toContain("disabled=");
  });
});

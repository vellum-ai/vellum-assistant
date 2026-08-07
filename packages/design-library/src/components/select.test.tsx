import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Select, type SelectOption } from "./select";

const options: SelectOption<"anthropic" | "openai">[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

function attr(html: string, tag: string, name: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`);
  return re.exec(html)?.[1] ?? null;
}

describe("Select field props", () => {
  test("labels the trigger it renders above", () => {
    const html = renderToStaticMarkup(
      <Select
        id="provider"
        label="Provider"
        options={options}
        value="anthropic"
        onChange={() => {}}
      />,
    );
    // The association is the point: a label that misses its control renders
    // identically and does nothing.
    expect(attr(html, "label", "for")).toBe("provider");
    expect(attr(html, "label", "id")).toBe("provider-label");
    expect(html).toContain('aria-labelledby="provider-label"');
  });

  test("announces the error and points the trigger at it", () => {
    const html = renderToStaticMarkup(
      <Select
        id="provider"
        label="Provider"
        errorText="Select a provider"
        options={options}
        value=""
        onChange={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Select a provider");
    expect(attr(html, "span", "id")).toBe("provider-error");
    expect(html).toContain('aria-describedby="provider-error"');
    expect(html).toContain('aria-invalid="true"');
    // Border tint, so the field reads as broken without relying on the text.
    expect(html).toContain("--system-negative-strong");
  });

  test("an error replaces helper text rather than stacking", () => {
    const html = renderToStaticMarkup(
      <Select
        id="provider"
        label="Provider"
        helperText="Where requests go"
        errorText="Select a provider"
        options={options}
        value=""
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Select a provider");
    expect(html).not.toContain("Where requests go");
  });

  test("helper text describes the trigger when valid", () => {
    const html = renderToStaticMarkup(
      <Select
        id="provider"
        label="Provider"
        helperText="Where requests go"
        options={options}
        value="anthropic"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-describedby="provider-helper"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-invalid");
  });

  test("stays a bare trigger when given no field text", () => {
    // Existing call sites position the trigger themselves; wrapping them in a
    // field would change their layout.
    const html = renderToStaticMarkup(
      <Select
        options={options}
        value="anthropic"
        onChange={() => {}}
        aria-label="Provider"
      />,
    );
    expect(html).not.toContain('data-slot="field-wrapper"');
    expect(html).not.toContain("<label");
  });
});

describe("nullable selection", () => {
  test("a null option renders as a real row", () => {
    // Radix addresses items by string, so the row needs a token. It is
    // internal: nothing outside this component names it, and no value has to
    // be reserved anywhere to avoid it.
    const html = renderToStaticMarkup(
      <Select
        aria-label="Profile"
        value={null}
        onChange={() => {}}
        options={[
          { value: null, label: "Default" },
          { value: "fast", label: "Fast" },
        ]}
      />,
    );
    // A closed Select renders only its trigger, so this asserts the real
    // thing: `value={null}` resolves to the null row and shows its label.
    expect(attr(html, "span", "title")).toBe("Default");
  });

  test("a value that looks like the internal token is still its own option", () => {
    // The token is derived from the values present, so a real value can never
    // be mistaken for the null row however it is spelled.
    const html = renderToStaticMarkup(
      <Select
        aria-label="Profile"
        value={"\u0000none" as string}
        onChange={() => {}}
        options={[
          { value: null, label: "Default" },
          { value: "\u0000none", label: "Literally the token" },
        ]}
      />,
    );
    expect(attr(html, "span", "title")).toBe("Literally the token");
  });
});

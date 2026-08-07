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

describe("Select trigger chrome", () => {
  function triggerClasses(markup: string): string {
    return attr(markup, "button", "class") ?? "";
  }

  /**
   * The default trigger is the path every pre-existing call site takes, and
   * its chrome is now assembled by branching on `variant`. These are the
   * pieces that branch, pinned so a future variant cannot quietly restyle the
   * control that most of the app renders.
   */
  test("the default trigger keeps its border, fill, width and height", () => {
    const classes = triggerClasses(
      renderToStaticMarkup(
        <Select
          aria-label="Provider"
          options={options}
          value="anthropic"
          onChange={() => {}}
        />,
      ),
    );
    expect(classes).toContain("w-full");
    expect(classes).toContain("bg-[var(--field-bg)]");
    expect(classes).toContain("border-[var(--field-border)]");
    expect(classes).toContain("h-9");
    expect(classes).toContain("focus:outline-none");
    // Ghost-only chrome must not leak into the default.
    expect(classes).not.toContain("bg-transparent");
    expect(classes).not.toContain("outline-transparent");
  });

  /**
   * Ghost exists to sit in a run of read-only values, which it can only do if
   * it claims no fixed height and draws its ring outside layout. Both are load
   * bearing: a bordered ring would keep 2px in layout and stand the row taller
   * than its neighbours, and a fixed height would defeat the variant outright.
   */
  test("the ghost trigger claims no height and rings itself with an outline", () => {
    const classes = triggerClasses(
      renderToStaticMarkup(
        <Select
          aria-label="Provider"
          variant="ghost"
          options={options}
          value="anthropic"
          onChange={() => {}}
        />,
      ),
    );
    expect(classes).toContain("w-auto");
    expect(classes).toContain("bg-transparent");
    expect(classes).toContain("outline-transparent");
    expect(classes).toContain("py-1");
    expect(classes).not.toContain("h-9");
    // A border would sit in layout and undo the height match.
    expect(classes).not.toContain("border-[var(--field-border)]");
    // The base rule that would erase the ghost's own focus ring.
    expect(classes).not.toContain("focus:outline-none");
  });
});

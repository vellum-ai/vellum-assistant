import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Dropdown, type DropdownOption } from "./dropdown";

const options: DropdownOption<"a" | "b">[] = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
];

describe("Dropdown", () => {
  test("renders the selected option label in the trigger", () => {
    const html = renderToStaticMarkup(
      <Dropdown options={options} value="a" onChange={() => {}} aria-label="Test" />,
    );
    expect(html).toContain("Option A");
  });

  test("renders placeholder when no value matches", () => {
    const html = renderToStaticMarkup(
      <Dropdown
        options={options}
        value={"" as "a"}
        onChange={() => {}}
        placeholder="Pick one…"
        aria-label="Test"
      />,
    );
    expect(html).toContain("Pick one…");
  });

  test("renders suffix in the trigger when the selected option has one", () => {
    const withSuffix: DropdownOption<"a" | "b">[] = [
      { value: "a", label: "Option A", suffix: <span data-testid="suffix">Current</span> },
      { value: "b", label: "Option B" },
    ];
    const html = renderToStaticMarkup(
      <Dropdown options={withSuffix} value="a" onChange={() => {}} aria-label="Test" />,
    );
    expect(html).toContain('data-testid="suffix"');
    expect(html).toContain("Current");
  });

  test("does not render suffix in the trigger when the selected option has none", () => {
    const withSuffix: DropdownOption<"a" | "b">[] = [
      { value: "a", label: "Option A", suffix: <span data-testid="suffix">Current</span> },
      { value: "b", label: "Option B" },
    ];
    const html = renderToStaticMarkup(
      <Dropdown options={withSuffix} value="b" onChange={() => {}} aria-label="Test" />,
    );
    expect(html).not.toContain('data-testid="suffix"');
    expect(html).not.toContain("Current");
  });

  test("renders disabled trigger with aria attributes", () => {
    const html = renderToStaticMarkup(
      <Dropdown options={options} value="a" onChange={() => {}} disabled aria-label="Test" />,
    );
    expect(html).toContain("disabled");
  });
});

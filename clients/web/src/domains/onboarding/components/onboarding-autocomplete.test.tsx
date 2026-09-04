import { useState } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { TagAutocompleteInput } from "@/domains/onboarding/components/onboarding-autocomplete";

afterEach(cleanup);

/** Stateful host, so committed chips feed back in as the `values` prop. */
function TagField({
  initialValues = [],
  suggestions = [],
}: {
  initialValues?: string[];
  suggestions?: readonly string[];
}) {
  const [values, setValues] = useState<string[]>(initialValues);
  return (
    <>
      <TagAutocompleteInput
        label="Hobbies"
        values={values}
        onChange={setValues}
        suggestions={suggestions}
      />
      <output data-testid="values">{values.join("|")}</output>
    </>
  );
}

function chips(): string {
  return screen.getByTestId("values").textContent ?? "";
}

/**
 * Type one character at a time the way a soft keyboard does: every key reaches
 * the input's value, and no key-specific keydown is dispatched.
 */
function type(input: HTMLInputElement, text: string) {
  for (const char of text) {
    fireEvent.change(input, { target: { value: `${input.value}${char}` } });
  }
}

describe("TagAutocompleteInput", () => {
  test("claims Escape only while its suggestion list is open", () => {
    render(
      <TagAutocompleteInput
        label="Interests"
        values={[]}
        onChange={() => {}}
        suggestions={["Music"]}
      />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");

    const closeEvent = createEvent.keyDown(input, {
      key: "Escape",
      cancelable: true,
    });
    fireEvent(input, closeEvent);
    expect(closeEvent.defaultPrevented).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    const closedEvent = createEvent.keyDown(input, {
      key: "Escape",
      cancelable: true,
    });
    fireEvent(input, closedEvent);
    expect(closedEvent.defaultPrevented).toBe(false);
  });

  test("splits typed commas into one chip per segment", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "Reading, Painting");

    expect(chips()).toBe("Reading");
    expect(input.value).toBe("Painting");
  });

  test("splits a comma typed behind a hardware-keyboard keydown once", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "Reading");
    fireEvent.keyDown(input, { key: "," });
    type(input, ",");

    expect(chips()).toBe("Reading");
    expect(input.value).toBe("");
  });

  test("commits every segment of a pasted list", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    fireEvent.paste(input, {
      clipboardData: { getData: () => "Reading, Painting, Baking" },
    });

    expect(chips()).toBe("Reading|Painting|Baking");
    expect(input.value).toBe("");
  });

  test("pastes a list into the text already typed", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "Read");
    input.setSelectionRange(4, 4);
    fireEvent.paste(input, {
      clipboardData: { getData: () => "ing, Painting" },
    });

    expect(chips()).toBe("Reading|Painting");
    expect(input.value).toBe("");
  });

  test("keeps text after the last comma as the live query", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "Reading, Cook");

    expect(chips()).toBe("Reading");
    expect(input.value).toBe("Cook");
  });

  test("ignores whitespace-only segments", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "Reading,   , Painting,");

    expect(chips()).toBe("Reading|Painting");
    expect(input.value).toBe("");
  });

  test("does not duplicate a segment that matches an existing chip", () => {
    render(<TagField initialValues={["Reading"]} />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    type(input, "reading, Painting,");

    expect(chips()).toBe("Reading|Painting");
    expect(input.value).toBe("");
  });

  test("defers comma splitting until IME composition ends", () => {
    render(<TagField />);
    const input = screen.getByRole<HTMLInputElement>("combobox");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "Reading," } });

    expect(chips()).toBe("");
    expect(input.value).toBe("Reading,");

    fireEvent.compositionEnd(input);

    expect(chips()).toBe("Reading");
    expect(input.value).toBe("");

    type(input, "Painting,");

    expect(chips()).toBe("Reading|Painting");
    expect(input.value).toBe("");
  });
});

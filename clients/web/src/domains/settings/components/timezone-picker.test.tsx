/**
 * Tests for `TimezonePicker`, the "Closest city" combobox in Settings.
 *
 * The load-bearing property is freshness: the options the keyboard walks and
 * commits are the ones the typed text produced. An earlier version filtered
 * off a 200ms-debounced copy of the query, so a fast typist could press Enter
 * inside the window and commit a row belonging to the previous query while
 * the field showed the new one.
 *
 * `Intl.supportedValuesOf` supplies the zone list in this environment, so the
 * assertions name zones that exist in every ICU build rather than a fixture.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TimezonePicker } from "@/domains/settings/components/timezone-picker";

afterEach(cleanup);

function renderPicker(): { picked: string[]; field: HTMLElement } {
  const picked: string[] = [];
  render(
    <TimezonePicker
      value="America/New_York"
      onChange={(v) => picked.push(v)}
    />,
  );
  return {
    picked,
    field: screen.getByRole("combobox", { name: "Closest city" }),
  };
}

describe("TimezonePicker", () => {
  test("commits the match for the text in the field, with no window where it does not", () => {
    const { picked, field } = renderPicker();

    // No waiting between the keystrokes and the commit: this is the race the
    // debounce used to lose.
    fireEvent.focusIn(field);
    fireEvent.change(field, { target: { value: "Tokyo" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(picked).toEqual(["Asia/Tokyo"]);
  });

  test("a query narrowed to one row commits that row, not the first of the old list", () => {
    const { picked, field } = renderPicker();

    fireEvent.focusIn(field);
    fireEvent.change(field, { target: { value: "Lisb" } });
    // Retyping into a narrower query used to leave the highlight on the wider
    // list's first row.
    fireEvent.change(field, { target: { value: "Lisbon" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(picked).toEqual(["Europe/Lisbon"]);
  });

  test("clearing the query takes the highlight with it, so Enter picks nothing", () => {
    const { picked, field } = renderPicker();

    fireEvent.focusIn(field);
    fireEvent.change(field, { target: { value: "Tokyo" } });
    expect(field.getAttribute("aria-activedescendant")).not.toBeNull();

    fireEvent.change(field, { target: { value: "" } });
    expect(field.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(field, { key: "Enter" });
    expect(picked).toEqual([]);
  });

  test("the field carries the combobox wiring, and the list it names exists", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);

    const listbox = screen.getByRole("listbox", { name: "Cities" });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    // The relationship has to resolve: an idref to nothing is worse than none.
    expect(field.getAttribute("aria-controls")).toBe(listbox.id);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  test("a query that matches nothing says so and stays dismissable", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);
    fireEvent.change(field, { target: { value: "zzzz" } });

    expect(screen.getByRole("listbox", { name: "Cities" }).textContent).toBe(
      "No matching cities",
    );

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

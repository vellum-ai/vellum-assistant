/**
 * Tests for `TimezonePicker`, the "Timezone" combobox in Settings.
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
    field: screen.getByRole("combobox", { name: "Timezone" }),
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

    const listbox = screen.getByRole("listbox", { name: "Timezones" });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    // The relationship has to resolve: an idref to nothing is worse than none.
    expect(field.getAttribute("aria-controls")).toBe(listbox.id);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  test("an offset-shaped query matches by resolved offset, in every common spelling", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);

    // DST-free zones so the expected offsets hold year-round: Phoenix pins
    // GMT-7 and Colombo pins GMT+5:30. (Asia/Colombo rather than
    // Asia/Kolkata: some ICU builds canonicalize the latter to the legacy
    // Asia/Calcutta id, which renders a different city name.)
    for (const spelling of ["UTC-7", "gmt-7", "-07:00"]) {
      fireEvent.change(field, { target: { value: spelling } });
      expect(screen.getByText("Phoenix")).toBeTruthy();
    }
    for (const spelling of ["UTC+5:30", "+5:30", "utc+0530"]) {
      fireEvent.change(field, { target: { value: spelling } });
      expect(screen.getByText("Colombo")).toBeTruthy();
    }
  });

  test("bare UTC and GMT mean the zero offset, not a substring", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);

    // A substring read would match every zone for GMT (every offset label
    // starts with it) and nothing for UTC on ICU builds that omit the
    // literal UTC zone. Reykjavik pins GMT+0 year-round; Tokyo proves the
    // list is offset-filtered rather than showing everything.
    for (const spelling of ["UTC", "GMT", "utc"]) {
      fireEvent.change(field, { target: { value: spelling } });
      expect(screen.getByText("Reykjavik")).toBeTruthy();
      expect(screen.queryByText("Tokyo")).toBeNull();
    }
  });

  test("a malformed minute field fails closed instead of aliasing to the next hour", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);

    // 5:60 must not be read as 6:00, and 12:60 not as 13:00: a typo that
    // silently selected a neighboring zone would save the wrong timezone.
    for (const malformed of ["UTC+5:60", "UTC+12:60", "-0:60"]) {
      fireEvent.change(field, { target: { value: malformed } });
      expect(
        screen.getByRole("listbox", { name: "Timezones" }).textContent,
      ).toBe("No matches");
    }
  });

  test("a query that matches nothing says so and stays dismissable", () => {
    const { field } = renderPicker();

    fireEvent.focusIn(field);
    fireEvent.change(field, { target: { value: "zzzz" } });

    expect(screen.getByRole("listbox", { name: "Timezones" }).textContent).toBe(
      "No matches",
    );

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

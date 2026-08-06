/**
 * Tests for the relative date-range control and the hook that derives its
 * bounds.
 *
 * The invariant that matters: bounds for a relative preset are anchored on the
 * current calendar day, so they must follow a rollover on their own. Held in
 * state instead, they silently address yesterday while the trigger still reads
 * "Last 30 days".
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";

import { DateRangeSelect, usePresetRange } from "./date-range-select";

const TZ = "UTC";

afterEach(() => {
  setSystemTime();
  cleanup();
});

describe("usePresetRange", () => {
  test("bounds follow the calendar day across a rollover", () => {
    setSystemTime(new Date("2026-08-06T23:59:00Z"));
    const { result } = renderHook(() => usePresetRange(30, TZ));

    expect(result.current).toEqual({ from: "2026-07-08", to: "2026-08-06" });
    const beforeMidnight = result.current;

    setSystemTime(new Date("2026-08-07T00:01:00Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Both bounds move: a relative window that kept yesterday's `to` would be
    // querying a stale day while claiming to be the same preset.
    expect(result.current).toEqual({ from: "2026-07-09", to: "2026-08-07" });
    expect(result.current).not.toBe(beforeMidnight);
  });

  test("re-checking inside the same day yields the same range object", () => {
    setSystemTime(new Date("2026-08-06T10:00:00Z"));
    const { result } = renderHook(() => usePresetRange(30, TZ));
    const first = result.current;

    setSystemTime(new Date("2026-08-06T22:00:00Z"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    // Referential equality, not just deep equality: the day guard has to stop
    // the re-check from re-rendering every consumer of the range.
    expect(result.current).toBe(first);
  });

  test("a zone change lands in the first render, with no wrong value between", () => {
    // At this instant Niue (UTC-11) is still on Aug 6 while Kiritimati (UTC+14)
    // has reached Aug 7, so the two zones disagree about today's date.
    setSystemTime(new Date("2026-08-06T12:00:00Z"));

    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ tz }: { tz: string }) => {
        const range = usePresetRange(30, tz);
        seen.push(range.to);
        return range;
      },
      { initialProps: { tz: "Pacific/Niue" } },
    );
    expect(seen).toEqual(["2026-08-06"]);

    seen.length = 0;
    rerender({ tz: "Pacific/Kiritimati" });

    // Every render after the change reports the new zone's date. A date held in
    // state and corrected by an effect would show the old zone's for one render
    // first, and the billing query keyed on it would fetch that window.
    expect(seen).toEqual(["2026-08-07"]);
  });

  test("a preset's span is its own, not the default's", () => {
    setSystemTime(new Date("2026-08-06T12:00:00Z"));
    const { result } = renderHook(() => usePresetRange(7, TZ));

    expect(result.current).toEqual({ from: "2026-07-31", to: "2026-08-06" });
  });
});

describe("DateRangeSelect", () => {
  test("shows the preset it is handed", () => {
    render(<DateRangeSelect value={90} onChange={() => {}} />);

    // The trigger shows the identity it was handed, not one inferred from a
    // range's span.
    expect(screen.getByLabelText("Date range").textContent).toBe(
      "Last 90 days",
    );
  });

  test("falls back to the default rather than rendering blank", () => {
    render(<DateRangeSelect value={45} onChange={() => {}} />);

    expect(screen.getByLabelText("Date range").textContent).toBe(
      "Last 30 days",
    );
  });
});

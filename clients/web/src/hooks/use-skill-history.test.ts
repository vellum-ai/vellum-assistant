import { describe, expect, test } from "bun:test";

import { shouldShowHistoryTab } from "./use-skill-history";

/**
 * The History tab's visibility rule. Three inputs collapse into one boolean,
 * and two of the combinations are the ones reviewers flagged as easy to get
 * wrong: an in-flight read must not flash the tab, and a failed read must not
 * be mistaken for an empty one.
 */

describe("shouldShowHistoryTab", () => {
  test("shows the tab when there are revisions", () => {
    expect(
      shouldShowHistoryTab({
        isLoading: false,
        isError: false,
        revisionCount: 2,
      }),
    ).toBe(true);
  });

  test("hides the tab for a skill with nothing recorded", () => {
    expect(
      shouldShowHistoryTab({
        isLoading: false,
        isError: false,
        revisionCount: 0,
      }),
    ).toBe(false);
  });

  test("shows the tab when the read failed, so the failure is reportable", () => {
    // An errored query also reports zero revisions. Without this branch the
    // page would render as though the skill had never been edited, hiding a
    // transient failure behind a plausible-looking empty state.
    expect(
      shouldShowHistoryTab({
        isLoading: false,
        isError: true,
        revisionCount: 0,
      }),
    ).toBe(true);
  });

  test("hides the tab while the read is in flight", () => {
    // Gating on the count alone would render the strip, then remove it a
    // moment later when the empty result landed.
    expect(
      shouldShowHistoryTab({
        isLoading: true,
        isError: false,
        revisionCount: 0,
      }),
    ).toBe(false);
  });

  test("loading wins over a stale error, so a retry does not flicker", () => {
    expect(
      shouldShowHistoryTab({
        isLoading: true,
        isError: true,
        revisionCount: 0,
      }),
    ).toBe(false);
  });
});

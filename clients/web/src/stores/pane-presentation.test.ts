/**
 * Holds `panePresentation` to the arrangements the workspace renders.
 *
 * The cases below are taken from the predicates the layout reads: a side
 * panel needs `mainView === "app-editing"` with both an app and a bound
 * conversation, the strip needs `mainView === "app"` with the app minimized,
 * and a full-width app is `mainView === "app"` otherwise. Combinations
 * outside those are unreachable and are not enumerated.
 *
 * The comparison is on what a viewer sees, because `"single"` and `"full"`
 * are one picture: a surface filling the width. They differ only in whether a
 * secondary is collapsed behind it, which the stored fields cannot express
 * and which is asserted separately below.
 */

import { describe, expect, it } from "bun:test";

import {
  panePresentation,
  type PanePosition,
  type PanePresentation,
} from "@/stores/pane-presentation";

/** What a viewer sees, with arrangements that look alike collapsed together. */
type Rendered = "one-surface" | "two-columns" | "stacked-strip";

function rendered(presentation: PanePresentation): Rendered {
  switch (presentation) {
    case "side":
      return "two-columns";
    case "bottom":
      return "stacked-strip";
    case "single":
    case "full":
      return "one-surface";
  }
}

interface ReachableState {
  readonly name: string;
  /** What the layout renders from the stored fields. */
  readonly today: Rendered;
  /** The same state read as the facts the derivation takes. */
  readonly hasSecondary: boolean;
  readonly position: PanePosition;
  readonly isNarrow: boolean;
}

const REACHABLE: readonly ReachableState[] = [
  {
    name: "app open, no conversation beside it",
    today: "one-surface",
    hasSecondary: false,
    position: "full",
    isNarrow: false,
  },
  {
    name: "app and conversation side by side",
    today: "two-columns",
    hasSecondary: true,
    position: "side",
    isNarrow: false,
  },
  {
    name: "app minimized to the strip, conversation in front",
    today: "stacked-strip",
    hasSecondary: true,
    position: "bottom",
    isNarrow: true,
  },
  {
    name: "app expanded again, conversation still bound behind it",
    today: "one-surface",
    hasSecondary: true,
    position: "full",
    isNarrow: false,
  },
  {
    name: "no app, conversation alone",
    today: "one-surface",
    hasSecondary: false,
    position: "side",
    isNarrow: false,
  },
  {
    name: "no app, conversation alone, narrow",
    today: "one-surface",
    hasSecondary: false,
    position: "side",
    isNarrow: true,
  },
];

describe("panePresentation matches what the workspace renders", () => {
  for (const state of REACHABLE) {
    it(state.name, () => {
      expect(
        rendered(
          panePresentation({
            hasSecondary: state.hasSecondary,
            position: state.position,
            isNarrow: state.isNarrow,
          }),
        ),
      ).toBe(state.today);
    });
  }
});

describe("panePresentation", () => {
  it("shows one surface when no secondary is open", () => {
    for (const position of ["side", "bottom", "full"] as const) {
      for (const isNarrow of [false, true]) {
        expect(
          panePresentation({ hasSecondary: false, position, isNarrow }),
        ).toBe("single");
      }
    }
  });

  it("keeps a collapsed secondary distinct from no secondary", () => {
    // The distinction the stored fields cannot draw, and the reason a
    // full-width app can still be returned to its conversation in one click.
    expect(
      panePresentation({
        hasSecondary: true,
        position: "full",
        isNarrow: false,
      }),
    ).toBe("full");
    expect(
      panePresentation({
        hasSecondary: false,
        position: "full",
        isNarrow: false,
      }),
    ).toBe("single");
  });

  it("honours the asked-for position when there is room", () => {
    expect(
      panePresentation({
        hasSecondary: true,
        position: "side",
        isNarrow: false,
      }),
    ).toBe("side");
    expect(
      panePresentation({
        hasSecondary: true,
        position: "bottom",
        isNarrow: false,
      }),
    ).toBe("bottom");
  });

  it("narrows side to bottom without disturbing the preference", () => {
    const asked: PanePosition = "side";
    expect(
      panePresentation({ hasSecondary: true, position: asked, isNarrow: true }),
    ).toBe("bottom");
    expect(
      panePresentation({
        hasSecondary: true,
        position: asked,
        isNarrow: false,
      }),
    ).toBe("side");
  });

  it("leaves full width alone on a narrow viewport", () => {
    expect(
      panePresentation({
        hasSecondary: true,
        position: "full",
        isNarrow: true,
      }),
    ).toBe("full");
  });
});

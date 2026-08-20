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
  viewerPanePresentation,
  type PanePosition,
  type PanePresentation,
} from "@/stores/pane-presentation";
import type { MainView } from "@/stores/viewer-store";

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

describe("viewerPanePresentation reads the stored fields", () => {
  // The two combinations below are the reference: an arrangement is correct
  // when it agrees with them across every combination the fields can hold.
  const MAIN_VIEWS: readonly MainView[] = [
    "chat",
    "app",
    "app-editing",
    "document",
  ];
  const BOOLS = [false, true];

  /** The field combination that means side by side. */
  function rendersSplit(
    mainView: MainView,
    hasApp: boolean,
    hasBoundConversation: boolean,
  ): boolean {
    return mainView === "app-editing" && hasApp && hasBoundConversation;
  }

  /** The field combination that means the app is parked to its strip. */
  function rendersStrip(
    mainView: MainView,
    hasApp: boolean,
    isAppMinimized: boolean,
  ): boolean {
    return mainView === "app" && isAppMinimized && hasApp;
  }

  for (const mainView of MAIN_VIEWS) {
    for (const hasApp of BOOLS) {
      for (const hasBoundConversation of BOOLS) {
        for (const isAppMinimized of BOOLS) {
          const fields = {
            mainView,
            hasApp,
            hasBoundConversation,
            isAppMinimized,
          };
          const label = `${mainView}, app=${hasApp}, bound=${hasBoundConversation}, minimized=${isAppMinimized}`;

          it(`${label}: side matches the split's condition`, () => {
            expect(viewerPanePresentation(fields) === "side").toBe(
              rendersSplit(mainView, hasApp, hasBoundConversation),
            );
          });

          it(`${label}: bottom matches the strip's condition`, () => {
            expect(viewerPanePresentation(fields) === "bottom").toBe(
              rendersStrip(mainView, hasApp, isAppMinimized),
            );
          });
        }
      }
    }
  }

  it("reports no secondary once the viewer has moved off the app", () => {
    const offApp: readonly MainView[] = ["chat", "document", "skill-detail"];
    for (const mainView of offApp) {
      expect(
        viewerPanePresentation({
          mainView,
          hasApp: true,
          hasBoundConversation: true,
          isAppMinimized: false,
        }),
      ).toBe("single");
    }
  });
});

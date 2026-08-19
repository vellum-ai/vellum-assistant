/**
 * Holds the derived arrangement to the one the stored fields produce today.
 *
 * The migration rests on a claim: `mainView`'s `"app"` and `"app-editing"`,
 * plus `isAppMinimized`, carry nothing beyond whether a secondary surface is
 * open and where it was asked for. These cases are that claim, written as the
 * table the stored fields produce, so a derivation that disagrees with any
 * combination they can reach fails here rather than in a layout nobody sees.
 */

import { describe, expect, it } from "bun:test";

import {
  panePresentation,
  type PanePosition,
  type PanePresentation,
} from "@/stores/pane-presentation";

/**
 * The four arrangements reachable from the stored fields.
 *
 * The third is the one worth naming: `exitAppEditing()` sets `mainView` back
 * to `"app"` while leaving the bound conversation in place, so the app fills
 * the width with a secondary still open behind it. That is `"full"`, and it
 * already exists in the app; it simply has no name.
 */
function storedArrangement(
  mainView: string,
  isAppMinimized: boolean,
  hasBoundConversation: boolean,
): PanePresentation {
  if (mainView === "app-editing") {
    return "side";
  }
  if (mainView !== "app") {
    return "single";
  }
  if (isAppMinimized) {
    return "bottom";
  }
  return hasBoundConversation ? "full" : "single";
}

/** The same stored fields read as the two facts the derivation takes. */
function asInput(
  mainView: string,
  isAppMinimized: boolean,
  hasBoundConversation: boolean,
): { hasSecondary: boolean; position: PanePosition } {
  const position: PanePosition =
    mainView === "app-editing" ? "side" : isAppMinimized ? "bottom" : "full";
  return { hasSecondary: hasBoundConversation, position };
}

describe("panePresentation reproduces the stored arrangement", () => {
  for (const mainView of ["app", "app-editing"]) {
    for (const isAppMinimized of [false, true]) {
      for (const hasBoundConversation of [false, true]) {
        const label = `${mainView}, minimized=${isAppMinimized}, bound=${hasBoundConversation}`;

        it(`${label}, wide`, () => {
          const stored = storedArrangement(
            mainView,
            isAppMinimized,
            hasBoundConversation,
          );
          const derived = panePresentation({
            ...asInput(mainView, isAppMinimized, hasBoundConversation),
            isNarrow: false,
          });
          expect(derived).toBe(stored);
        });

        it(`${label}, narrow`, () => {
          const stored = storedArrangement(
            mainView,
            isAppMinimized,
            hasBoundConversation,
          );
          const derived = panePresentation({
            ...asInput(mainView, isAppMinimized, hasBoundConversation),
            isNarrow: true,
          });

          // The single deliberate disagreement. The stored fields can hold
          // `"app-editing"` on a viewport with no room for two columns;
          // nothing puts them there, since selecting a conversation beside an
          // app refuses a narrow viewport outright. Two columns in that space
          // is the defect, so the derivation answers `"bottom"` instead of
          // reproducing it.
          if (stored === "side") {
            expect(derived).toBe("bottom");
            return;
          }
          expect(derived).toBe(stored);
        });
      }
    }
  }
});

describe("panePresentation", () => {
  it("shows one pane when no secondary is open", () => {
    for (const position of ["side", "bottom", "full"] as const) {
      for (const isNarrow of [false, true]) {
        expect(
          panePresentation({ hasSecondary: false, position, isNarrow }),
        ).toBe("single");
      }
    }
  });

  it("keeps a collapsed secondary distinct from no secondary", () => {
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
    // The same preference, given room again, still answers what was asked.
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

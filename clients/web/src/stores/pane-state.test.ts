/**
 * Holds `paneState` to the conditions the layouts render on, and to the two
 * properties that make one derivation worth having: a pane never holds
 * nothing while the arrangement claims two, and the arrangement never
 * disagrees with the pair.
 */

import { describe, expect, it } from "bun:test";

import { paneState } from "@/stores/pane-state";
import type { MainView } from "@/stores/viewer-store";

const MAIN_VIEWS: readonly MainView[] = [
  "chat",
  "app",
  "app-editing",
  "document",
  "tool-detail",
];
const BOOLS = [false, true] as const;

function fields(
  mainView: MainView,
  hasApp: boolean,
  hasBound: boolean,
  hasConversation: boolean,
  isAppMinimized: boolean,
) {
  return {
    mainView,
    appId: hasApp ? "app-1" : null,
    conversationId: hasConversation ? "conv-active" : null,
    boundConversationId: hasBound ? "conv-bound" : null,
    isAppMinimized,
  };
}

describe("paneState across every combination the fields can hold", () => {
  for (const mainView of MAIN_VIEWS) {
    for (const hasApp of BOOLS) {
      for (const hasBound of BOOLS) {
        for (const hasConversation of BOOLS) {
          for (const isAppMinimized of BOOLS) {
            const label = `${mainView}, app=${hasApp}, bound=${hasBound}, conversation=${hasConversation}, minimized=${isAppMinimized}`;
            const state = () =>
              paneState(
                fields(
                  mainView,
                  hasApp,
                  hasBound,
                  hasConversation,
                  isAppMinimized,
                ),
              );

            it(`${label}: side by side needs an app and a conversation bound to it`, () => {
              expect(state().presentation === "side").toBe(
                mainView === "app-editing" && hasApp && hasBound,
              );
            });

            it(`${label}: the strip needs an app and a conversation to stand in front`, () => {
              expect(state().presentation === "bottom").toBe(
                mainView === "app" &&
                  isAppMinimized &&
                  hasApp &&
                  hasConversation,
              );
            });

            it(`${label}: no pane holds nothing while the arrangement claims two`, () => {
              const { presentation, primary, secondary } = state();
              if (presentation === "single") {
                expect(secondary).toBeNull();
                return;
              }
              expect(primary).not.toBeNull();
              expect(secondary).not.toBeNull();
            });
          }
        }
      }
    }
  }
});

describe("paneState", () => {
  it("gives the conversation the workspace when no app is open", () => {
    expect(paneState(fields("chat", false, false, true, false))).toEqual({
      presentation: "single",
      primary: { kind: "conversation", id: "conv-active" },
      secondary: null,
    });
  });

  it("puts the app first with the conversation beside it", () => {
    expect(paneState(fields("app-editing", true, true, true, false))).toEqual({
      presentation: "side",
      primary: { kind: "app", id: "app-1" },
      secondary: { kind: "conversation", id: "conv-bound" },
    });
  });

  it("inverts the pair when the app is parked to its strip", () => {
    expect(paneState(fields("app", true, false, true, true))).toEqual({
      presentation: "bottom",
      primary: { kind: "conversation", id: "conv-active" },
      secondary: { kind: "app", id: "app-1" },
    });
  });

  it("keeps the collapsed conversation while the app fills the width", () => {
    expect(paneState(fields("app", true, true, true, false))).toEqual({
      presentation: "full",
      primary: { kind: "app", id: "app-1" },
      secondary: { kind: "conversation", id: "conv-bound" },
    });
  });

  it("gives a parked app the surface when there is no conversation to stand in front", () => {
    // Not a strip over an empty pane: one surface, and the arrangement says so.
    expect(paneState(fields("app", true, false, false, true))).toEqual({
      presentation: "single",
      primary: { kind: "app", id: "app-1" },
      secondary: null,
    });
  });

  it("reports nothing at all before a conversation or app exists", () => {
    expect(paneState(fields("chat", false, false, false, false))).toEqual({
      presentation: "single",
      primary: null,
      secondary: null,
    });
  });
});

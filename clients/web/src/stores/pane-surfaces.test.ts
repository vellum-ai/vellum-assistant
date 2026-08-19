import { describe, expect, it } from "bun:test";

import {
  paneSurfaces,
  showsSecondary,
  type PaneSurfaceFields,
} from "@/stores/pane-surfaces";
import { viewerPanePresentation } from "@/stores/pane-presentation";
import type { MainView } from "@/stores/viewer-store";

const MAIN_VIEWS: readonly MainView[] = [
  "chat",
  "app",
  "app-editing",
  "document",
];
const BOOLS = [false, true] as const;

function fieldsFor(
  mainView: MainView,
  hasApp: boolean,
  hasBound: boolean,
  isAppMinimized: boolean,
): PaneSurfaceFields {
  return {
    mainView,
    appId: hasApp ? "app-1" : null,
    conversationId: "conv-active",
    boundConversationId: hasBound ? "conv-bound" : null,
    isAppMinimized,
  };
}

describe("paneSurfaces agrees with the arrangement", () => {
  for (const mainView of MAIN_VIEWS) {
    for (const hasApp of BOOLS) {
      for (const hasBound of BOOLS) {
        for (const isAppMinimized of BOOLS) {
          const label = `${mainView}, app=${hasApp}, bound=${hasBound}, minimized=${isAppMinimized}`;

          it(`${label}: a secondary exists exactly when the arrangement is not single`, () => {
            const fields = fieldsFor(
              mainView,
              hasApp,
              hasBound,
              isAppMinimized,
            );
            const arrangement = viewerPanePresentation({
              mainView,
              hasApp,
              hasBoundConversation: hasBound,
              isAppMinimized,
            });

            expect(paneSurfaces(fields).secondary !== null).toBe(
              arrangement !== "single",
            );
          });
        }
      }
    }
  }
});

describe("paneSurfaces", () => {
  it("gives the conversation the workspace when no app is open", () => {
    const { primary, secondary } = paneSurfaces(
      fieldsFor("chat", false, false, false),
    );
    expect(primary).toEqual({ kind: "conversation", id: "conv-active" });
    expect(secondary).toBeNull();
  });

  it("puts the app first and the conversation beside it", () => {
    const { primary, secondary } = paneSurfaces(
      fieldsFor("app-editing", true, true, false),
    );
    expect(primary).toEqual({ kind: "app", id: "app-1" });
    expect(secondary).toEqual({ kind: "conversation", id: "conv-bound" });
  });

  it("inverts the pair when the app is parked to its strip", () => {
    const { primary, secondary } = paneSurfaces(
      fieldsFor("app", true, false, true),
    );
    expect(primary).toEqual({ kind: "conversation", id: "conv-active" });
    expect(secondary).toEqual({ kind: "app", id: "app-1" });
  });

  it("keeps the collapsed conversation while the app fills the width", () => {
    const { primary, secondary } = paneSurfaces(
      fieldsFor("app", true, true, false),
    );
    expect(primary).toEqual({ kind: "app", id: "app-1" });
    expect(secondary).toEqual({ kind: "conversation", id: "conv-bound" });
  });

  it("holds no secondary for an app opened with nothing beside it", () => {
    expect(paneSurfaces(fieldsFor("app", true, false, false)).secondary).toBe(
      null,
    );
  });

  it("carries no surface at all before a conversation is selected", () => {
    expect(
      paneSurfaces({
        mainView: "chat",
        appId: null,
        conversationId: null,
        boundConversationId: null,
        isAppMinimized: false,
      }),
    ).toEqual({ primary: null, secondary: null });
  });
});

describe("showsSecondary", () => {
  it("shows it beside and below, and holds it collapsed at full width", () => {
    expect(showsSecondary("side")).toBe(true);
    expect(showsSecondary("bottom")).toBe(true);
    expect(showsSecondary("full")).toBe(false);
    expect(showsSecondary("single")).toBe(false);
  });
});

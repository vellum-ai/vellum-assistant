/**
 * The viewer-store selectors {@link useComposerOnScreen} reads, for the suites
 * that replace that module wholesale to keep its generated-SDK imports out of
 * the test.
 *
 * The three have to agree with each other: the app view covers the composer
 * only while an app is there to draw, so the id travels with the view.
 * Deriving `openedAppState` from the id in one place is what keeps a suite
 * from seeding a view that names an app the viewer never holds.
 */

import type { useViewerStore, ViewerStore } from "@/stores/viewer-store";

/** The viewer fields a suite drives. */
type ComposerViewerFields = Pick<ViewerStore, "mainView" | "activeAppId">;

/** The `useViewerStore.use` selectors the composer calls. */
type ComposerViewerSelectors = Pick<
  (typeof useViewerStore)["use"],
  "mainView" | "activeAppId" | "openedAppState"
>;

/** A `@/stores/viewer-store` stand-in whose selectors report `read()`. */
export function composerViewerStoreMock(read: () => ComposerViewerFields): {
  useViewerStore: { use: ComposerViewerSelectors };
} {
  return {
    useViewerStore: {
      use: {
        mainView: () => read().mainView,
        activeAppId: () => read().activeAppId,
        openedAppState: () => {
          const { activeAppId } = read();
          return activeAppId === null
            ? null
            : {
                assistantId: "asst-1",
                appId: activeAppId,
                name: "App",
                html: "",
              };
        },
      },
    },
  };
}

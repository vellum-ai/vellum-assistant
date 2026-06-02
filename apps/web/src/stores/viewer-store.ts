/**
 * Zustand store for viewer UI state.
 *
 * Manages panel navigation and the app/document viewer lifecycle as
 * direct named actions.
 *
 * **State managed:**
 * - `mainView` — which top-level panel is displayed
 * - `activeAppId` / `openedAppState` — app viewer
 * - `openedDocumentState` — document viewer
 * - `isAppMinimized` — mobile-only: app viewer minimized
 * - `intelligenceTab` — sub-tab inside the intelligence panel
 * - `assetsRefreshKey` — counter bumped to force asset re-fetches
 * - `viewBeforeDocument` / `viewBeforeSubagentDetail` / `viewBeforeToolDetail` — previous view for restoration
 * - `activeSubagentId` — subagent detail panel
 * - `activeToolDetail` — tool-call detail drawer payload
 *
 * App share/deploy lifecycle lives in `domains/chat/deploy-store.ts`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { captureError } from "@/lib/sentry/capture-error";
import { create } from "zustand";

import { appsByIdOpenPost, documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { createSelectors } from "@/utils/create-selectors";

/** Views that overlay the main content and track a "back" destination. */
type OverlayView = "document" | "subagent-detail" | "tool-detail";

/**
 * Resolve the "view before" value for overlay navigation.
 *
 * When navigating to an overlay view (document, subagent-detail, tool-detail),
 * the previous non-overlay view is preserved so the close action can restore
 * it. If already inside an overlay, the existing saved view is kept rather
 * than capturing the current overlay as the "back" destination.
 */
/**
 * The daemon returns app-load failures as a structured error envelope
 * (`{ error: { code: "NOT_FOUND", message } }`) when the app reference
 * has been deleted server-side — that's the shape produced by
 * `httpError(...)` in `assistant/src/runtime/http-errors.ts` and the
 * shape recorded in Sentry breadcrumbs for this issue. The HeyAPI
 * client's `throwOnError: true` then throws that envelope as the catch
 * value. Treat it as an expected condition — the UI falls back to chat
 * — rather than a Sentry-worthy crash.
 *
 * **Narrow to the app-missing case via the message.** A bare `code:
 * "NOT_FOUND"` match would also swallow route-mismatch / version-skew
 * 404s (the daemon's catch-all returns `{ error: { code: "NOT_FOUND",
 * message: "Not found" } }`), and *those* are real telemetry we want
 * Sentry to see. The app-open handlers throw `NotFoundError("App not
 * found")` or `NotFoundError("App not found: ${appId}")` (see
 * `assistant/src/runtime/routes/app-routes.ts` and `app-management-routes.ts`),
 * so a `startsWith("App not found")` check matches the deleted-app case
 * specifically without swallowing routing bugs.
 *
 * **Two assumptions, both verified by `viewer-store.test.ts`:**
 *
 * 1. The daemon wraps the body in an `error` key (`assistant/src/runtime/http-errors.ts`).
 * 2. HeyAPI's `throwOnError: true` throws that body verbatim, not wrapped in
 *    an `Error` subclass (current behavior of `@hey-api/client-fetch`,
 *    bundled inline by `@hey-api/openapi-ts`).
 *
 * If a future HeyAPI upgrade wraps errors in an `Error` instance with the
 * body on a `.data` (or similar) property, this check silently stops
 * matching and NOT_FOUND noise comes back to Sentry — graceful degradation,
 * not a crash. The accompanying test will still pass (it tests our helper's
 * contract, not HeyAPI's). The signal to update is the Sentry issue
 * reopening, at which point this function and its test get adjusted to the
 * new envelope shape.
 */
export function isAppNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const envelope = (err as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) return false;
  if ((envelope as { code?: unknown }).code !== "NOT_FOUND") return false;
  const message = (envelope as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("App not found");
}

/**
 * Fetch an app's html and store it as `openedAppState`, WITHOUT touching
 * `mainView` — the caller owns the view transition (`loadApp` → `"app"`,
 * `revealAppForBuild` → `"app-editing"`). Bails out if the active app
 * changed while the request was in flight. Shared so both callers get the
 * same 404-tolerance + cache-priming behavior.
 */
async function fetchAndSetApp(
  set: (partial: Partial<ViewerState>) => void,
  get: () => ViewerStore,
  assistantId: string,
  appId: string,
): Promise<void> {
  try {
    const { data: result } = await appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    });
    if (get().activeAppId !== appId) return;
    const app = { appId: result.appId, dirName: result.dirName, name: result.name, html: result.html };
    set({ openedAppState: app });
    primeAppHtmlCache(assistantId, result.appId, result.html);
  } catch (err) {
    if (get().activeAppId !== appId) return;
    // 404s here are an expected condition (app was deleted on the
    // server but the client still has a reference). Skip the Sentry
    // capture for those — the daemon already returns a structured
    // `{ code: "NOT_FOUND", message }` body — and let the UI fall
    // back to chat as below. Unexpected failures still report.
    if (!isAppNotFoundError(err)) {
      captureError(err, { context: "openApp" });
    }
    set({ mainView: "chat", activeAppId: null, openedAppState: null });
  }
}

function resolveViewBefore(
  state: ViewerState,
  field: "viewBeforeDocument" | "viewBeforeSubagentDetail" | "viewBeforeToolDetail",
): Exclude<MainView, OverlayView> {
  const mv = state.mainView;
  if (mv === "document" || mv === "subagent-detail" || mv === "tool-detail") {
    return state[field];
  }
  return mv as Exclude<MainView, OverlayView>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MainView =
  | "chat"
  | "app"
  | "app-editing"
  | "document"
  | "subagent-detail"
  | "tool-detail";

export type IntelligenceTab = "identity" | "skills" | "workspace" | "contacts";

export interface OpenedAppState {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
  /**
   * Live-build status from the daemon's `app_preview_update` stream.
   * Undefined for apps that haven't received a live-build event (e.g. just
   * opened). `error` surfaces a non-blocking badge over the last-good html.
   */
  compileStatus?: "building" | "ok" | "error";
  /** Compile diagnostics from the last `error` event; surfaced in the badge. */
  buildErrors?: string[];
  /**
   * Generation counter bumped by the daemon on every SUCCESSFUL recompile
   * (`compileStatus: "ok"`). Folded into the iframe key so a successful
   * rebuild force-swaps the preview even when the resolved html is
   * byte-identical to the currently open one.
   */
  reloadGeneration?: number;
}

export interface OpenedDocumentState {
  surfaceId: string;
  conversationId: string;
  documentName: string;
  content: string;
}

export interface ToolDetailPayload {
  toolCallId: string;
  toolName: string;
  title: string; // phase title, e.g. "Spawning subagent"
  activity: string; // rich sentence (may be "")
  input: Record<string, unknown>;
  result?: string;
  status: "running" | "completed" | "error" | "denied";
  riskLevel?: string;
  riskReason?: string;
  durationLabel?: string;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ViewerState {
  mainView: MainView;
  activeAppId: string | null;
  openedAppState: OpenedAppState | null;
  /**
   * App id the user explicitly dismissed (closed/exited) during the
   * current build, so the auto-open (`revealAppForBuild`) does not fight
   * the user by popping the panel back open for that same build. Reset
   * to `null` when a fresh build sequence begins for a different app, or
   * when the user reopens an app. Transient UI state, not persisted.
   */
  dismissedBuildAppId: string | null;
  activeDocumentSurfaceId: string | null;
  openedDocumentState: OpenedDocumentState | null;
  isAppMinimized: boolean;
  intelligenceTab: IntelligenceTab;
  assetsRefreshKey: number;
  viewBeforeDocument: Exclude<MainView, "document" | "subagent-detail" | "tool-detail">;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, "document" | "subagent-detail" | "tool-detail">;
  activeToolDetail: ToolDetailPayload | null;
  viewBeforeToolDetail: Exclude<MainView, "document" | "subagent-detail" | "tool-detail">;
}

export interface ViewerActions {
  // --- View navigation ---
  setMainView: (view: MainView) => void;
  setIntelligenceTab: (tab: IntelligenceTab) => void;

  // --- App viewer ---
  openApp: (appId: string) => void;
  loadApp: (assistantId: string, appId: string) => Promise<void>;
  /**
   * Auto-open the chat-left / preview-right split-view for an app whose
   * build just started (driven by the first `app_preview_update` event).
   * Sets `mainView: "app-editing"` + `activeAppId` and loads the first
   * frame; live `app_preview_update`s then hot-swap the preview (PR 3).
   */
  revealAppForBuild: (assistantId: string, appId: string) => void;
  setLoadedApp: (app: OpenedAppState) => void;
  updateOpenedAppPreview: (
    appId: string,
    update: {
      html?: string;
      compileStatus: "building" | "ok" | "error";
      buildErrors?: string[];
      reloadGeneration: number;
    },
  ) => void;
  handleAppLoadFailed: () => void;
  closeApp: () => void;
  /**
   * Clear the build-dismissal flag for `appId` (no-op if it doesn't
   * match), letting `revealAppForBuild` auto-open the panel again on the
   * NEXT build. Called by the app-preview hook when a fresh build
   * sequence begins for an app the user previously dismissed.
   */
  clearBuildDismissal: (appId: string) => void;
  toggleAppMinimized: () => void;
  handleAppUnpinned: (appId: string) => boolean;
  enterAppEditing: () => void;
  exitAppEditing: () => void;

  // --- Subagent detail ---
  openSubagentDetail: (subagentId: string) => void;
  closeSubagentDetail: () => void;

  // --- Tool detail ---
  openToolDetail: (payload: ToolDetailPayload) => void;
  closeToolDetail: () => void;

  // --- Document viewer ---
  openDocument: () => void;
  loadDocument: (assistantId: string, documentSurfaceId: string) => Promise<void>;
  setLoadedDocument: (document: OpenedDocumentState) => void;
  updateDocumentContent: (surfaceId: string, content: string, mode: string) => void;
  handleDocumentLoadFailed: () => void;
  closeDocument: () => void;

  // --- Assets ---
  refreshAssets: () => void;

  // --- Reset ---
  reset: () => void;
}

export type ViewerStore = ViewerState & ViewerActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: ViewerState = {
  mainView: "chat",
  activeAppId: null,
  openedAppState: null,
  dismissedBuildAppId: null,
  activeDocumentSurfaceId: null,
  openedDocumentState: null,
  isAppMinimized: false,
  intelligenceTab: "identity",
  assetsRefreshKey: 0,
  viewBeforeDocument: "chat",
  activeSubagentId: null,
  viewBeforeSubagentDetail: "chat",
  activeToolDetail: null,
  viewBeforeToolDetail: "chat",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useViewerStoreBase = create<ViewerStore>()((set, get) => ({
  ...INITIAL_STATE,

  // --- View navigation ---

  setMainView: (view) => {
    if (get().mainView === view) return;
    set({ mainView: view });
  },

  setIntelligenceTab: (tab) => {
    if (get().intelligenceTab === tab) return;
    set({ intelligenceTab: tab });
  },

  // --- App viewer ---

  openApp: (appId) => {
    set({
      mainView: "app",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
      // Re-opening an app clears any stale dismissal for it so a later
      // build's auto-open isn't suppressed by an old close.
      dismissedBuildAppId: null,
    });
  },

  loadApp: async (assistantId, appId) => {
    set({
      mainView: "app",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
      dismissedBuildAppId: null,
    });
    await fetchAndSetApp(set, get, assistantId, appId);
  },

  revealAppForBuild: (assistantId, appId) => {
    const state = get();
    // Already looking at this app — never yank the view (or re-fetch)
    // out from under the user mid-build. `app-editing` and the
    // full-width `app` view both count as "viewing this app".
    if (
      state.activeAppId === appId &&
      (state.mainView === "app" || state.mainView === "app-editing")
    ) {
      return;
    }
    // The user explicitly closed the panel for this app during the
    // current build — respect that and don't pop it back open. The
    // hook clears this flag (`clearBuildDismissal`) when a fresh build
    // sequence begins, so the next build re-opens.
    if (state.dismissedBuildAppId === appId) return;
    set({
      mainView: "app-editing",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
    });
    // Load the first frame; subsequent `app_preview_update`s hot-swap
    // the preview (PR 3) via `updateOpenedAppPreview`. `fetchAndSetApp`
    // keeps `mainView` untouched (unlike `loadApp`), so the split-view
    // we just entered survives the async load. Fire-and-forget — the
    // helper bails on its own if the active app changed meanwhile.
    void fetchAndSetApp(set, get, assistantId, appId);
  },

  setLoadedApp: (app) => {
    set({ openedAppState: app });
  },

  /**
   * Apply a daemon `app_preview_update` live-build event to the open app.
   *
   * No-ops unless the event targets the currently active app and that app is
   * already loaded — stale events for a since-closed/switched app are dropped.
   *
   * Keep-last-good: only an `ok` event carries fresh html and swaps the
   * preview. `building`/`error` update the status/errors but leave `html`
   * AND `reloadGeneration` untouched so the last working preview stays
   * visible and the iframe is not remounted on a transient failure.
   *
   * The daemon bumps `reloadGeneration` on every successful recompile so
   * clients force-swap the iframe (it's folded into the iframe key). A
   * successful rebuild whose resolved html is byte-identical therefore still
   * remounts the preview — so the no-op guard below only skips when the html,
   * generation, AND status are all unchanged.
   */
  updateOpenedAppPreview: (
    appId,
    { html, compileStatus, buildErrors, reloadGeneration },
  ) => {
    const prev = get().openedAppState;
    if (!prev || get().activeAppId !== appId || prev.appId !== appId) return;
    const isOk = compileStatus === "ok";
    const nextHtml = isOk && html !== undefined ? html : prev.html;
    // Only an `ok` event advances the stored generation; building/error keep
    // the last-good generation so a transient failure never remounts.
    const nextGeneration = isOk ? reloadGeneration : prev.reloadGeneration;
    // Skip the update (and the re-render / iframe churn it triggers) when
    // nothing observable changed — e.g. a repeated `building` heartbeat, or a
    // successful recompile that resolved to byte-identical html AND did not
    // bump the generation.
    if (
      prev.html === nextHtml &&
      prev.reloadGeneration === nextGeneration &&
      prev.compileStatus === compileStatus &&
      prev.buildErrors === buildErrors
    ) {
      return;
    }
    set({
      openedAppState: {
        ...prev,
        html: nextHtml,
        compileStatus,
        buildErrors,
        reloadGeneration: nextGeneration,
      },
    });
  },

  handleAppLoadFailed: () => {
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
    });
  },

  closeApp: () => {
    // Remember which app the user just dismissed so the build auto-open
    // (`revealAppForBuild`) doesn't immediately re-open the panel for the
    // same in-flight build. Cleared by `clearBuildDismissal` when a fresh
    // build sequence starts, or by re-opening the app (`openApp`/`loadApp`).
    const dismissedBuildAppId = get().activeAppId ?? get().dismissedBuildAppId;
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
      isAppMinimized: false,
      dismissedBuildAppId,
    });
  },

  clearBuildDismissal: (appId) => {
    if (get().dismissedBuildAppId !== appId) return;
    set({ dismissedBuildAppId: null });
  },

  toggleAppMinimized: () => {
    set({ isAppMinimized: !get().isAppMinimized });
  },

  handleAppUnpinned: (appId) => {
    const state = get();
    if (
      state.activeAppId !== appId ||
      (state.mainView !== "app" && state.mainView !== "app-editing")
    ) {
      return false;
    }
    get().closeApp();
    return true;
  },

  enterAppEditing: () => {
    set({ mainView: "app-editing" });
  },

  exitAppEditing: () => {
    set({ mainView: "app" });
  },

  // --- Subagent detail ---

  openSubagentDetail: (subagentId) => {
    set({
      mainView: "subagent-detail",
      activeSubagentId: subagentId,
      viewBeforeSubagentDetail: resolveViewBefore(get(), "viewBeforeSubagentDetail"),
    });
  },

  closeSubagentDetail: () => {
    set({
      mainView: get().viewBeforeSubagentDetail,
      activeSubagentId: null,
    });
  },

  // --- Tool detail ---

  openToolDetail: (payload) => {
    set({
      mainView: "tool-detail",
      activeToolDetail: payload,
      viewBeforeToolDetail: resolveViewBefore(get(), "viewBeforeToolDetail"),
    });
  },

  closeToolDetail: () => {
    set({
      mainView: get().viewBeforeToolDetail,
      activeToolDetail: null,
    });
  },

  // --- Document viewer ---

  openDocument: () => {
    set({
      mainView: "document",
      openedDocumentState: null,
      viewBeforeDocument: resolveViewBefore(get(), "viewBeforeDocument"),
    });
  },

  loadDocument: async (assistantId, documentSurfaceId) => {
    const viewBeforeDocument = resolveViewBefore(get(), "viewBeforeDocument");
    set({
      mainView: "document",
      activeDocumentSurfaceId: documentSurfaceId,
      openedDocumentState: null,
      viewBeforeDocument,
    });
    try {
      const { data: result } = await documentsByIdGet({
        path: { assistant_id: assistantId, id: documentSurfaceId },
        throwOnError: true,
      });
      if (get().activeDocumentSurfaceId !== documentSurfaceId) return;
      if (!result) {
        set({ mainView: viewBeforeDocument, activeDocumentSurfaceId: null, openedDocumentState: null });
        return;
      }
      set({
        openedDocumentState: {
          surfaceId: result.surfaceId,
          conversationId: result.conversationId,
          documentName: result.title ?? "Untitled",
          content: result.content ?? "",
        },
      });
    } catch {
      if (get().activeDocumentSurfaceId !== documentSurfaceId) return;
      set({ mainView: viewBeforeDocument, activeDocumentSurfaceId: null, openedDocumentState: null });
    }
  },

  setLoadedDocument: (document) => {
    set({ openedDocumentState: document });
  },

  updateDocumentContent: (surfaceId, content, mode) => {
    const state = get();
    if (!state.openedDocumentState || state.openedDocumentState.surfaceId !== surfaceId) return;
    const prev = state.openedDocumentState;
    const newContent = mode === "append" ? prev.content + content : content;
    set({ openedDocumentState: { ...prev, content: newContent } });
  },

  handleDocumentLoadFailed: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentSurfaceId: null,
      openedDocumentState: null,
    });
  },

  closeDocument: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentSurfaceId: null,
      openedDocumentState: null,
    });
  },

  // --- Assets ---

  refreshAssets: () => {
    set({ assetsRefreshKey: get().assetsRefreshKey + 1 });
  },

  // --- Reset ---

  /**
   * Restore viewer state to its initial value. Does NOT reset share/deploy
   * state — that lives in `useDeployStore` and has its own `reset()`.
   * Callers that want a full UI reset should call both.
   */
  reset: () => set({ ...INITIAL_STATE }),
}));

export const useViewerStore = createSelectors(useViewerStoreBase);

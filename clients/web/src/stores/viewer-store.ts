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
  /**
   * Variant discriminator. Absent or `"tool"` → the standard tool-call detail
   * view (technical details + output). `"thinking"` → the reasoning view that
   * renders `thinkingText` as markdown with no input/output sections.
   */
  kind?: "tool" | "thinking";
  /** Full reasoning markdown rendered when `kind === "thinking"`. */
  thinkingText?: string;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ViewerState {
  mainView: MainView;
  activeAppId: string | null;
  openedAppState: OpenedAppState | null;
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
  /**
   * Monotonic counter bumped when a viewer (e.g. the mobile tool-detail
   * overlay, which lives in a separate portal subtree) asks to open the trust
   * rule editor for `activeToolDetail`. `ChatMainPanel` owns the rule-editor
   * state, so it watches this seq and performs the open against `messages`.
   */
  ruleEditorRequestSeq: number;
}

export interface ViewerActions {
  // --- View navigation ---
  setMainView: (view: MainView) => void;
  setIntelligenceTab: (tab: IntelligenceTab) => void;

  // --- App viewer ---
  openApp: (appId: string) => void;
  loadApp: (assistantId: string, appId: string) => Promise<void>;
  setLoadedApp: (app: OpenedAppState) => void;
  handleAppLoadFailed: () => void;
  closeApp: () => void;
  toggleAppMinimized: () => void;
  handleAppUnpinned: (appId: string) => boolean;
  enterAppEditing: () => void;
  exitAppEditing: () => void;

  // --- Subagent detail ---
  openSubagentDetail: (subagentId: string) => void;
  closeSubagentDetail: () => void;

  // --- Tool detail ---
  openToolDetail: (payload: ToolDetailPayload) => void;
  /**
   * Open the tool-detail drawer for `payload`, or close it when the drawer is
   * already open showing the SAME target. Powers the inline activity links
   * (thought-process + single-tool chip) where clicking an already-active chip
   * dismisses the drawer.
   */
  toggleToolDetail: (payload: ToolDetailPayload) => void;
  closeToolDetail: () => void;
  requestRuleEditorForActiveTool: () => void;

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
  ruleEditorRequestSeq: 0,
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
    });
  },

  loadApp: async (assistantId, appId) => {
    set({
      mainView: "app",
      activeAppId: appId,
      openedAppState: null,
      isAppMinimized: false,
    });
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
  },

  setLoadedApp: (app) => {
    set({ openedAppState: app });
  },

  handleAppLoadFailed: () => {
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
    });
  },

  closeApp: () => {
    set({
      mainView: "chat",
      activeAppId: null,
      openedAppState: null,
      isAppMinimized: false,
    });
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

  toggleToolDetail: (payload) => {
    const state = get();
    const active = state.activeToolDetail;
    const isSameTarget =
      state.mainView === "tool-detail" &&
      active != null &&
      (payload.kind === "thinking"
        ? active.kind === "thinking" &&
          active.thinkingText === payload.thinkingText
        : active.kind !== "thinking" &&
          active.toolCallId === payload.toolCallId);
    if (isSameTarget) {
      get().closeToolDetail();
    } else {
      get().openToolDetail(payload);
    }
  },

  closeToolDetail: () => {
    set({
      mainView: get().viewBeforeToolDetail,
      activeToolDetail: null,
    });
  },

  requestRuleEditorForActiveTool: () => {
    if (!get().activeToolDetail) return;
    set((s) => ({ ruleEditorRequestSeq: s.ruleEditorRequestSeq + 1 }));
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

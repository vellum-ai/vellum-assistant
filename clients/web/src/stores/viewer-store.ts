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
 * - `viewBeforeDocument` / `viewBeforeSubagentDetail` / `viewBeforeToolDetail` / `viewBeforeWorkflowDetail` / `viewBeforeAcpRunDetail` — previous view for restoration
 * - `activeSubagentId` — subagent detail panel
 * - `activeToolDetail` — tool-call detail drawer payload
 * - `activeActivitySteps` — activity-steps side panel payload (a group's full timeline)
 * - `activeWorkflowRunId` — workflow detail panel
 * - `activeAcpRunId` — ACP run detail panel
 * - `activeBackgroundTaskId` — background-task detail panel
 * - `activeSkillDetailId` — skill detail panel
 *
 * App share/deploy lifecycle lives in `domains/chat/deploy-store.ts`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { captureError } from "@/lib/sentry/capture-error";
import { create } from "zustand";

import type { SetupChannelId } from "@/types/channel-types";
import type { ProcessKind } from "@/domains/chat/process-registry/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";
import { appsByIdOpenPost, documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { primeAppHtmlCache } from "@/utils/app-html-cache";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import { createSelectors } from "@/utils/create-selectors";

/** Views that overlay the main content and track a "back" destination. */
type OverlayView =
  | "document"
  | "subagent-detail"
  | "tool-detail"
  | "activity-steps"
  | "workflow-detail"
  | "acp-run-detail"
  | "background-task-detail"
  | "skill-detail"
  | "channel-setup";

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
  field:
    | "viewBeforeDocument"
    | "viewBeforeSubagentDetail"
    | "viewBeforeToolDetail"
    | "viewBeforeActivitySteps"
    | "viewBeforeWorkflowDetail"
    | "viewBeforeAcpRunDetail"
    | "viewBeforeBackgroundTaskDetail"
    | "viewBeforeSkillDetail"
    | "viewBeforeChannelSetup",
): Exclude<MainView, OverlayView> {
  const mv = state.mainView;
  if (
    mv === "document" ||
    mv === "subagent-detail" ||
    mv === "tool-detail" ||
    mv === "activity-steps" ||
    mv === "workflow-detail" ||
    mv === "acp-run-detail" ||
    mv === "background-task-detail" ||
    mv === "skill-detail" ||
    mv === "channel-setup"
  ) {
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
  | "tool-detail"
  | "activity-steps"
  | "workflow-detail"
  | "acp-run-detail"
  | "background-task-detail"
  | "skill-detail"
  | "channel-setup";

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

export type ChannelSetupType = SetupChannelId;

export interface ChannelSetupPayload {
  channel: ChannelSetupType;
  assistantId: string;
  assistantName: string;
  /**
   * Conversation that opened the wizard (from the `open_panel` event).
   * Targets the close auto-notify at the originating conversation even if
   * the user switches conversations while the drawer is open. Absent when
   * the panel was opened outside an assistant conversation.
   */
  conversationId?: string;
}

export interface ToolDetailPayload {
  toolCallId: string;
  toolName: string;
  title: string; // phase title, e.g. "Spawning subagent"
  activity: string; // rich sentence (may be "")
  input: Record<string, unknown>;
  result?: string;
  /**
   * Open-time snapshot of the live streamed tool output (e.g. foreground bash
   * stdout/stderr). Only a fallback: an open drawer re-derives the live value
   * from the chat-session store via `useLiveToolCall`, so this is used only
   * when the tool call can't be resolved live (e.g. paged out).
   */
  streamedOutput?: string;
  status: "running" | "completed" | "error" | "denied";
  riskLevel?: string;
  riskReason?: string;
  durationLabel?: string;
  /**
   * Variant discriminator. Absent or `"tool"` → the standard tool-call detail
   * view (technical details + output). `"thinking"` → the reasoning view that
   * renders `thinkingText` as markdown with no input/output sections.
   * `"web_search"` → the search view that renders `searchQuery` + the
   * `searchResults` source list with no technical input/output sections.
   */
  kind?: "tool" | "thinking" | "web_search";
  /**
   * Reasoning markdown captured when the drawer was opened. Used as the
   * fallback when the live source (below) can't be resolved.
   */
  thinkingText?: string;
  /**
   * The search query for a `"web_search"` detail, rendered verbatim above the
   * source list. Unset for other kinds.
   */
  searchQuery?: string;
  /**
   * The parsed result sources for a `"web_search"` detail, rendered as the same
   * favicon source chips the timeline uses. Empty while the search is still in
   * flight. Unset for other kinds.
   */
  searchResults?: WebSearchResultItem[];
  /**
   * Stable identity of the reasoning run this drawer mirrors. When present, the
   * panel re-derives live text from the chat-session store (via
   * `useLiveThinkingText`) so an open drawer streams instead of freezing
   * `thinkingText`. `messageId` + `thinkingGroupIndex` locate the activity
   * group; `thinkingItemIndex` selects a single segment within it (omitted for
   * the bare combined "Thought process" panel).
   */
  messageId?: string;
  thinkingGroupIndex?: number;
  thinkingItemIndex?: number;
}

/**
 * Payload for the activity-steps side panel — the full steps timeline of one
 * contiguous thinking + tool run (a `MultiActivityGroup`).
 *
 * `messageId` + `groupIndex` are the stable identity of the activity group in
 * the transcript: the open panel re-derives live items from the chat-session
 * store (via `useLiveActivityGroup`) so it streams as new steps land. The
 * embedded `items` / `toolCalls` are the open-time snapshot, used only when
 * the live source can't be resolved (message paged out, or identity-less
 * callers like stories).
 */
export interface ActivityStepsPayload {
  messageId?: string;
  groupIndex?: number;
  items: ToolCallCardItem[];
  toolCalls: ChatMessageToolCall[];
}

/**
 * Whether two activity-steps payloads address the same transcript group.
 * Keys on the stable (message, group) identity when present, falling back to
 * the first tool-call id for identity-less callers.
 */
export function sameActivityStepsTarget(
  a: ActivityStepsPayload,
  b: ActivityStepsPayload,
): boolean {
  if (a.messageId != null || b.messageId != null) {
    return a.messageId === b.messageId && a.groupIndex === b.groupIndex;
  }
  return a.toolCalls[0]?.id === b.toolCalls[0]?.id;
}

/** The identity fields a thinking drawer target is matched on. */
type ThinkingTarget = Pick<
  ToolDetailPayload,
  "messageId" | "thinkingGroupIndex" | "thinkingItemIndex" | "thinkingText"
>;

/**
 * Whether `active` addresses the same reasoning as `target`. Keys on the stable
 * (message, group, segment) identity when `target` carries one — so the match
 * holds while the reasoning text streams — and falls back to text equality for
 * identity-less targets (web-synthesized "Reading…" steps, stories/tests).
 *
 * Single source of truth for the inline thinking affordances' selected state
 * (`SingleActivity`, `MultiActivityGroup`) and the drawer toggle below.
 */
export function sameThinkingTarget(
  active: ThinkingTarget,
  target: ThinkingTarget,
): boolean {
  if (target.messageId != null) {
    return (
      active.messageId === target.messageId &&
      active.thinkingGroupIndex === target.thinkingGroupIndex &&
      active.thinkingItemIndex === target.thinkingItemIndex
    );
  }
  return active.thinkingText === target.thinkingText;
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
  viewBeforeDocument: Exclude<MainView, OverlayView>;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, OverlayView>;
  activeToolDetail: ToolDetailPayload | null;
  viewBeforeToolDetail: Exclude<MainView, OverlayView>;
  activeActivitySteps: ActivityStepsPayload | null;
  viewBeforeActivitySteps: Exclude<MainView, OverlayView>;
  activeWorkflowRunId: string | null;
  viewBeforeWorkflowDetail: Exclude<MainView, OverlayView>;
  activeAcpRunId: string | null;
  viewBeforeAcpRunDetail: Exclude<MainView, OverlayView>;
  activeBackgroundTaskId: string | null;
  viewBeforeBackgroundTaskDetail: Exclude<MainView, OverlayView>;
  activeSkillDetailId: string | null;
  viewBeforeSkillDetail: Exclude<MainView, OverlayView>;
  activeChannelSetup: ChannelSetupPayload | null;
  viewBeforeChannelSetup: Exclude<MainView, OverlayView>;
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

  // --- Workflow detail ---
  openWorkflowDetail: (runId: string) => void;
  closeWorkflowDetail: () => void;

  // --- ACP run detail ---
  openAcpRunDetail: (acpSessionId: string) => void;
  closeAcpRunDetail: () => void;

  // --- Background task detail ---
  openBackgroundTaskDetail: (id: string) => void;
  closeBackgroundTaskDetail: () => void;

  // --- Skill detail ---
  openSkillDetail: (skillId: string) => void;
  closeSkillDetail: () => void;

  // --- Process-detail routing facade ---
  /**
   * Opens any background-process detail panel by `{ kind, id }`, delegating to
   * the matching per-kind `openXDetail` action so every process kind routes
   * through one call site. Handles the four process kinds (subagent, workflow,
   * acp-run, background-task); `tool-detail`, `document`, and `channel-setup`
   * keep their own dedicated open actions.
   */
  openProcessDetail: (ref: { kind: ProcessKind; id: string }) => void;
  /**
   * Close whichever of the four process-detail panels (subagent, workflow,
   * acp-run, background-task) is currently open, restoring the prior view. A
   * no-op when none of the four is the active view. Mirrors the existing
   * Escape behavior for these kinds; does not handle tool-detail, document, or
   * channel-setup.
   */
  closeActiveDetail: () => void;

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

  // --- Activity steps panel ---
  openActivitySteps: (payload: ActivityStepsPayload) => void;
  /**
   * Open the activity-steps panel for `payload`, or close it when the panel
   * is already showing the SAME group. Powers the multi-activity header where
   * clicking the already-open group dismisses the panel.
   */
  toggleActivitySteps: (payload: ActivityStepsPayload) => void;
  closeActivitySteps: () => void;

  // --- Channel setup ---
  openChannelSetup: (payload: ChannelSetupPayload) => void;
  closeChannelSetup: () => void;

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
  activeActivitySteps: null,
  viewBeforeActivitySteps: "chat",
  activeWorkflowRunId: null,
  viewBeforeWorkflowDetail: "chat",
  activeAcpRunId: null,
  viewBeforeAcpRunDetail: "chat",
  activeBackgroundTaskId: null,
  viewBeforeBackgroundTaskDetail: "chat",
  activeSkillDetailId: null,
  viewBeforeSkillDetail: "chat",
  activeChannelSetup: null,
  viewBeforeChannelSetup: "chat",
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

  // --- Workflow detail ---

  openWorkflowDetail: (runId) => {
    set({
      mainView: "workflow-detail",
      activeWorkflowRunId: runId,
      viewBeforeWorkflowDetail: resolveViewBefore(get(), "viewBeforeWorkflowDetail"),
    });
  },

  closeWorkflowDetail: () => {
    set({
      mainView: get().viewBeforeWorkflowDetail,
      activeWorkflowRunId: null,
    });
  },

  // --- ACP run detail ---

  openAcpRunDetail: (acpSessionId) => {
    set({
      mainView: "acp-run-detail",
      activeAcpRunId: acpSessionId,
      viewBeforeAcpRunDetail: resolveViewBefore(get(), "viewBeforeAcpRunDetail"),
    });
  },

  closeAcpRunDetail: () => {
    set({
      mainView: get().viewBeforeAcpRunDetail,
      activeAcpRunId: null,
    });
  },

  // --- Background task detail ---

  openBackgroundTaskDetail: (id) => {
    set({
      mainView: "background-task-detail",
      activeBackgroundTaskId: id,
      viewBeforeBackgroundTaskDetail: resolveViewBefore(get(), "viewBeforeBackgroundTaskDetail"),
    });
  },

  closeBackgroundTaskDetail: () => {
    set({
      mainView: get().viewBeforeBackgroundTaskDetail,
      activeBackgroundTaskId: null,
    });
  },

  // --- Skill detail ---

  openSkillDetail: (skillId) => {
    set({
      mainView: "skill-detail",
      activeSkillDetailId: skillId,
      viewBeforeSkillDetail: resolveViewBefore(get(), "viewBeforeSkillDetail"),
    });
  },

  closeSkillDetail: () => {
    set({
      mainView: get().viewBeforeSkillDetail,
      activeSkillDetailId: null,
    });
  },

  // --- Process-detail routing facade ---

  openProcessDetail: ({ kind, id }) => {
    switch (kind) {
      case "subagent":
        get().openSubagentDetail(id);
        return;
      case "workflow":
        get().openWorkflowDetail(id);
        return;
      case "acp-run":
        get().openAcpRunDetail(id);
        return;
      case "background-task":
        get().openBackgroundTaskDetail(id);
        return;
      default: {
        const _exhaustive: never = kind;
        void _exhaustive;
      }
    }
  },

  closeActiveDetail: () => {
    switch (get().mainView) {
      case "subagent-detail":
        get().closeSubagentDetail();
        return;
      case "workflow-detail":
        get().closeWorkflowDetail();
        return;
      case "acp-run-detail":
        get().closeAcpRunDetail();
        return;
      case "background-task-detail":
        get().closeBackgroundTaskDetail();
        return;
      default:
        return;
    }
  },

  // --- Channel setup ---

  openChannelSetup: (payload) => {
    set({
      mainView: "channel-setup",
      activeChannelSetup: payload,
      viewBeforeChannelSetup: resolveViewBefore(get(), "viewBeforeChannelSetup"),
    });
  },

  closeChannelSetup: () => {
    set({
      mainView: get().viewBeforeChannelSetup,
      activeChannelSetup: null,
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
        ? active.kind === "thinking" && sameThinkingTarget(active, payload)
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

  // --- Activity steps panel ---

  openActivitySteps: (payload) => {
    set({
      mainView: "activity-steps",
      activeActivitySteps: payload,
      viewBeforeActivitySteps: resolveViewBefore(
        get(),
        "viewBeforeActivitySteps",
      ),
    });
  },

  toggleActivitySteps: (payload) => {
    const state = get();
    const active = state.activeActivitySteps;
    const isSameTarget =
      state.mainView === "activity-steps" &&
      active != null &&
      sameActivityStepsTarget(active, payload);
    if (isSameTarget) {
      get().closeActivitySteps();
    } else {
      get().openActivitySteps(payload);
    }
  },

  closeActivitySteps: () => {
    set({
      mainView: get().viewBeforeActivitySteps,
      activeActivitySteps: null,
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

/**
 * Zustand store for viewer UI state.
 *
 * Manages panel navigation and the app/document viewer lifecycle as
 * direct named actions.
 *
 * **State managed:**
 * - `mainView` — which top-level panel is displayed
 * - `activeAppId` / `openedAppState` — app viewer
 * - `activeDocumentTarget` / `openedDocumentState` — document viewer, holding
 *   a document surface (which may be bound to a workspace markdown file) or a
 *   read-only preview of a workspace file the editor cannot round-trip
 * - `isAppMinimized` — mobile-only: app viewer minimized
 * - `intelligenceTab` — sub-tab inside the intelligence panel
 * - `viewBeforeDocument` / `viewBeforeSubagentDetail` / `viewBeforeToolDetail` / `viewBeforeWorkflowDetail` / `viewBeforeAcpRunDetail` — previous view for restoration
 * - `activeSubagentId` — subagent detail panel
 * - `activeToolDetail` — tool-call detail drawer payload
 * - `activeActivitySteps` — activity-steps side panel payload (a group's full timeline)
 * - `activeMessageFiles` - message-files side panel payload (one message's attachments)
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
import type { DisplayAttachment } from "@/types/attachment-types";
import { toast } from "@vellumai/design-library";

import {
  appsByIdOpenPost,
  documentsByIdGet,
  documentsForworkspacefilePost,
} from "@/generated/daemon/sdk.gen";
import { ApiError } from "@/utils/api-errors";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { openWorkspaceFile } from "@/utils/open-workspace-file";
import { workspaceBasenameOf } from "@/domains/chat/utils/workspace-path-links";
import { useUnseenDocumentChangesStore } from "@/domains/chat/unseen-document-changes-store";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import { createSelectors } from "@/utils/create-selectors";

/** Views that overlay the main content and track a "back" destination. */
type OverlayView =
  | "document"
  | "subagent-detail"
  | "tool-detail"
  | "activity-steps"
  | "message-files"
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
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const envelope = (err as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) {
    return false;
  }
  if ((envelope as { code?: unknown }).code !== "NOT_FOUND") {
    return false;
  }
  const message = (envelope as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("App not found");
}

/**
 * What to tell the reader when opening a workspace file as a document fails.
 *
 * The daemon refuses these opens with a message written for a reader (the
 * file was deleted, the path is not markdown), so a client error's message is
 * repeated verbatim. A server fault or a transport failure carries no such
 * message, only `HTTP 500` or the fetch layer's own wording, so those get a
 * generic line instead of leaking plumbing into the toast.
 */
function workspaceDocumentErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status < 500 && err.message) {
    return err.message;
  }
  return "Couldn't open this file";
}

/**
 * The daemon messages the file-backed document route answers a 404 with
 * (`assistant/src/runtime/routes/documents-routes.ts`). Both are written for a
 * reader, and both mean the route ran and the file is genuinely gone.
 */
const WORKSPACE_FILE_404_MARKERS = [
  "File not found",
  "The file backing this document no longer exists",
];

/**
 * Whether a 404 means the daemon does not serve this route at all, rather than
 * the route answering that the file is gone.
 *
 * A web bundle can be newer than the assistant installed beside it, and an
 * unknown endpoint comes back through the daemon's catch-all as a bare
 * `{ error: { code: "NOT_FOUND", message: "Not found" } }`. Closing the drawer
 * and blaming the file for that would strand every markdown link on the older
 * assistant, so a 404 carrying neither of the route's own messages is read as
 * route-missing and the click falls back to the workspace browser, which every
 * assistant version serves.
 *
 * The marker check is the only signal available: the status code is identical
 * either way, so a genuine 404 whose wording changes daemon-side degrades to
 * the fallback navigation rather than to a broken link.
 */
function isWorkspaceFileRouteMissing(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) {
    return false;
  }
  return !WORKSPACE_FILE_404_MARKERS.some((marker) =>
    err.message.startsWith(marker),
  );
}

function resolveViewBefore(
  state: ViewerState,
  field:
    | "viewBeforeDocument"
    | "viewBeforeSubagentDetail"
    | "viewBeforeToolDetail"
    | "viewBeforeActivitySteps"
    | "viewBeforeMessageFiles"
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
    mv === "message-files" ||
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
  | "message-files"
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

/**
 * A document surface stored in the daemon's document database. Edits are saved
 * through the documents API and carry the document-id affordances (comments,
 * PDF export, feedback).
 */
export interface OpenedDbDocumentState {
  source: "document";
  surfaceId: string;
  conversationId: string;
  documentName: string;
  content: string;
  /**
   * The workspace markdown file this document is bound to, when it has one.
   * A file-backed document is a full document surface, since the daemon writes
   * every save through to the file, so it differs from any other document only
   * in carrying the path, which the transcript's file affordances match on to
   * show which file is open. Absent or `null` for a document that has no file
   * behind it.
   */
  workspacePath?: string | null;
}

/**
 * Workspace file formats the drawer renders read-only, without an editor.
 * `unsupported` is the catch-all: the drawer opens for every file type, and a
 * format no reader covers shows the file's identity plus the two ways out
 * (open in the workspace, download) rather than refusing to open at all.
 */
export type WorkspaceFilePreviewKind =
  | "csv"
  | "text"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "unsupported";

/**
 * A workspace file shown read-only in the drawer, because the markdown editor
 * could not round-trip it. Nothing is editable, so this variant carries no
 * content: the preview component reads the bytes from the query cache, which
 * stays the single owner of that server data.
 */
export interface OpenedWorkspaceFilePreviewState {
  source: "workspace-file-preview";
  workspacePath: string;
  documentName: string;
  previewKind: WorkspaceFilePreviewKind;
}

/**
 * What the document viewer is showing. The `source` discriminant decides
 * whether edits save anywhere: a document surface autosaves through the
 * documents API, and a preview saves nowhere.
 */
export type OpenedDocumentState =
  | OpenedDbDocumentState
  | OpenedWorkspaceFilePreviewState;

/**
 * The document the viewer is loading or showing, tracked so a load that
 * resolves after the user moved on can detect that it is stale. One union
 * rather than a surface-id field plus a path field, so "showing a file while a
 * surface id is active" cannot be represented.
 *
 * `workspace-file` is the in-flight target of a file-backed document open: the
 * surface id only exists once the daemon has answered, so until then the
 * request is addressed by the path the user clicked.
 */
export type DocumentTarget =
  | { source: "document"; surfaceId: string }
  | { source: "workspace-file"; workspacePath: string }
  | { source: "workspace-file-preview"; workspacePath: string };

/** Whether two document targets address the same document. */
export function sameDocumentTarget(
  a: DocumentTarget | null,
  b: DocumentTarget,
): boolean {
  if (a === null || a.source !== b.source) {
    return false;
  }
  if (a.source === "document" && b.source === "document") {
    return a.surfaceId === b.surfaceId;
  }
  // The same path opened as an editable file and as a preview are different
  // targets, and the `source` check above has already separated them.
  if (a.source === "document" || b.source === "document") {
    return false;
  }
  return a.workspacePath === b.workspacePath;
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

/**
 * Payload for the message-files side panel: every attachment on one
 * transcript message. The open panel re-derives live attachments from the
 * transcript by `messageId`; the embedded `attachments` array is the
 * open-time snapshot, used when that message is no longer in the loaded
 * transcript (paged out by history windowing).
 */
export interface MessageFilesPayload {
  messageId: string;
  attachments: DisplayAttachment[];
  assistantId?: string | null;
}

/** Whether two message-files payloads address the same transcript message. */
export function sameMessageFilesTarget(
  a: MessageFilesPayload,
  b: MessageFilesPayload,
): boolean {
  return a.messageId === b.messageId;
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
  activeDocumentTarget: DocumentTarget | null;
  openedDocumentState: OpenedDocumentState | null;
  isAppMinimized: boolean;
  intelligenceTab: IntelligenceTab;
  viewBeforeDocument: Exclude<MainView, OverlayView>;
  activeSubagentId: string | null;
  viewBeforeSubagentDetail: Exclude<MainView, OverlayView>;
  activeToolDetail: ToolDetailPayload | null;
  viewBeforeToolDetail: Exclude<MainView, OverlayView>;
  activeActivitySteps: ActivityStepsPayload | null;
  viewBeforeActivitySteps: Exclude<MainView, OverlayView>;
  activeMessageFiles: MessageFilesPayload | null;
  viewBeforeMessageFiles: Exclude<MainView, OverlayView>;
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
   * Monotonic counter bumped when a viewer (a tool-detail drawer or the
   * activity-steps drill-in, which may live in a separate portal subtree)
   * asks to open the trust rule editor for `ruleEditorRequestToolCallId`.
   * `ChatMainPanel` owns the rule-editor state, so it watches this seq and
   * performs the open against `messages`.
   */
  ruleEditorRequestSeq: number;
  /** The tool call the pending rule-editor request targets. */
  ruleEditorRequestToolCallId: string | null;
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
  minimizeApp: () => void;
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
  /** Close the active overlay view, returning whether one was closed. */
  closeActiveOverlay: () => boolean;

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
  /**
   * Ask the chat panel to open the trust-rule editor for `toolCallId`.
   * Callable from any surface showing a tool call's detail (the tool-detail
   * drawer, the activity-steps drill-in) — including portal subtrees that
   * can't reach the rule-editor state directly.
   */
  requestRuleEditor: (toolCallId: string) => void;

  // --- Activity steps panel ---
  openActivitySteps: (payload: ActivityStepsPayload) => void;
  /**
   * Open the activity-steps panel for `payload`, or close it when the panel
   * is already showing the SAME group. Powers the multi-activity header where
   * clicking the already-open group dismisses the panel.
   */
  toggleActivitySteps: (payload: ActivityStepsPayload) => void;
  closeActivitySteps: () => void;

  // --- Message files panel ---
  openMessageFiles: (payload: MessageFilesPayload) => void;
  /**
   * Open the files panel for `payload`, or close it when the panel is already
   * showing the SAME message. Powers the overflow tile, where clicking the
   * already-open tile dismisses the panel.
   */
  toggleMessageFiles: (payload: MessageFilesPayload) => void;
  closeMessageFiles: () => void;

  /**
   * Drop the payloads of the panels whose content is scoped to one
   * conversation's transcript. Called on conversation switch: the panels are
   * already dismissed by the `setMainView("chat")` that accompanies it, and
   * holding their payloads keeps the previous conversation's data alive -
   * `activeMessageFiles` in particular retains decoded attachment blob/data
   * URLs. Leaves `mainView` alone; this is a memory concern, not navigation.
   */
  clearTranscriptPanelPayloads: () => void;

  // --- Channel setup ---
  openChannelSetup: (payload: ChannelSetupPayload) => void;
  closeChannelSetup: () => void;

  // --- Document viewer ---
  openDocument: () => void;
  loadDocument: (
    assistantId: string,
    documentSurfaceId: string,
  ) => Promise<void>;
  /**
   * Open a markdown file from the assistant workspace in the document viewer.
   * The daemon finds or creates the document bound to that file and keeps the
   * two in step: the file wins at open, and every save writes back through to
   * it. So this opens a full document surface, with the comment panel,
   * assistant iteration, and PDF export a document carries.
   *
   * `conversationId` is the conversation the file was opened from, which the
   * document is bound to.
   */
  loadWorkspaceFileDocument: (
    assistantId: string,
    workspacePath: string,
    conversationId: string,
  ) => Promise<void>;
  /**
   * Open a workspace file the editor cannot round-trip (a spreadsheet, a Word
   * or PowerPoint package, media, or a format with no reader at all) read-only
   * in the document drawer. Synchronous: the preview owns its own bytes through
   * the query cache, so the store records only which file is on show.
   */
  openWorkspaceFilePreview: (
    workspacePath: string,
    previewKind: WorkspaceFilePreviewKind,
  ) => void;
  setLoadedDocument: (document: OpenedDocumentState) => void;
  updateDocumentContent: (
    surfaceId: string,
    content: string,
    mode: string,
  ) => void;
  handleDocumentLoadFailed: () => void;
  closeDocument: () => void;

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
  activeDocumentTarget: null,
  openedDocumentState: null,
  isAppMinimized: false,
  intelligenceTab: "identity",
  viewBeforeDocument: "chat",
  activeSubagentId: null,
  viewBeforeSubagentDetail: "chat",
  activeToolDetail: null,
  viewBeforeToolDetail: "chat",
  activeActivitySteps: null,
  viewBeforeActivitySteps: "chat",
  activeMessageFiles: null,
  viewBeforeMessageFiles: "chat",
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
  ruleEditorRequestToolCallId: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useViewerStoreBase = create<ViewerStore>()((set, get) => ({
  ...INITIAL_STATE,

  // --- View navigation ---

  setMainView: (view) => {
    if (get().mainView === view) {
      return;
    }
    set({ mainView: view });
  },

  setIntelligenceTab: (tab) => {
    if (get().intelligenceTab === tab) {
      return;
    }
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
      if (get().activeAppId !== appId) {
        return;
      }
      const app = {
        appId: result.appId,
        dirName: result.dirName,
        name: result.name,
        html: result.html,
      };
      set({ openedAppState: app });
      primeAppHtmlCache(assistantId, result.appId, result.html);
    } catch (err) {
      if (get().activeAppId !== appId) {
        return;
      }
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

  minimizeApp: () => {
    set({ isAppMinimized: true });
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
      viewBeforeSubagentDetail: resolveViewBefore(
        get(),
        "viewBeforeSubagentDetail",
      ),
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
      viewBeforeWorkflowDetail: resolveViewBefore(
        get(),
        "viewBeforeWorkflowDetail",
      ),
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
      viewBeforeAcpRunDetail: resolveViewBefore(
        get(),
        "viewBeforeAcpRunDetail",
      ),
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
      viewBeforeBackgroundTaskDetail: resolveViewBefore(
        get(),
        "viewBeforeBackgroundTaskDetail",
      ),
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

  closeActiveOverlay: () => {
    switch (get().mainView) {
      case "document":
        get().closeDocument();
        return true;
      case "subagent-detail":
        get().closeSubagentDetail();
        return true;
      case "tool-detail":
        get().closeToolDetail();
        return true;
      case "activity-steps":
        get().closeActivitySteps();
        return true;
      case "message-files":
        get().closeMessageFiles();
        return true;
      case "workflow-detail":
        get().closeWorkflowDetail();
        return true;
      case "acp-run-detail":
        get().closeAcpRunDetail();
        return true;
      case "background-task-detail":
        get().closeBackgroundTaskDetail();
        return true;
      case "skill-detail":
        get().closeSkillDetail();
        return true;
      case "channel-setup":
        get().closeChannelSetup();
        return true;
      default:
        return false;
    }
  },

  // --- Channel setup ---

  openChannelSetup: (payload) => {
    set({
      mainView: "channel-setup",
      activeChannelSetup: payload,
      viewBeforeChannelSetup: resolveViewBefore(
        get(),
        "viewBeforeChannelSetup",
      ),
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

  requestRuleEditor: (toolCallId) => {
    if (!toolCallId) {
      return;
    }
    set((s) => ({
      ruleEditorRequestSeq: s.ruleEditorRequestSeq + 1,
      ruleEditorRequestToolCallId: toolCallId,
    }));
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

  // --- Message files panel ---

  openMessageFiles: (payload) => {
    set({
      mainView: "message-files",
      activeMessageFiles: payload,
      viewBeforeMessageFiles: resolveViewBefore(
        get(),
        "viewBeforeMessageFiles",
      ),
    });
  },

  toggleMessageFiles: (payload) => {
    const state = get();
    const active = state.activeMessageFiles;
    const isSameTarget =
      state.mainView === "message-files" &&
      active != null &&
      sameMessageFilesTarget(active, payload);
    if (isSameTarget) {
      get().closeMessageFiles();
    } else {
      get().openMessageFiles(payload);
    }
  },

  closeMessageFiles: () => {
    set({
      mainView: get().viewBeforeMessageFiles,
      activeMessageFiles: null,
    });
  },

  clearTranscriptPanelPayloads: () => {
    set({
      activeMessageFiles: null,
      activeActivitySteps: null,
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
    const target: DocumentTarget = {
      source: "document",
      surfaceId: documentSurfaceId,
    };
    set({
      mainView: "document",
      activeDocumentTarget: target,
      openedDocumentState: null,
      viewBeforeDocument,
    });
    try {
      const { data: result } = await documentsByIdGet({
        path: { assistant_id: assistantId, id: documentSurfaceId },
        throwOnError: true,
      });
      if (!sameDocumentTarget(get().activeDocumentTarget, target)) {
        return;
      }
      if (!result) {
        set({
          mainView: viewBeforeDocument,
          activeDocumentTarget: null,
          openedDocumentState: null,
        });
        return;
      }
      set({
        openedDocumentState: {
          source: "document",
          surfaceId: result.surfaceId,
          conversationId: result.conversationId,
          documentName: result.title ?? "Untitled",
          content: result.content ?? "",
          workspacePath: result.workspacePath,
        },
      });
      useUnseenDocumentChangesStore
        .getState()
        .clearDocumentEverywhere(result.surfaceId);
    } catch {
      if (!sameDocumentTarget(get().activeDocumentTarget, target)) {
        return;
      }
      set({
        mainView: viewBeforeDocument,
        activeDocumentTarget: null,
        openedDocumentState: null,
      });
    }
  },

  loadWorkspaceFileDocument: async (
    assistantId,
    workspacePath,
    conversationId,
  ) => {
    const viewBeforeDocument = resolveViewBefore(get(), "viewBeforeDocument");
    const target: DocumentTarget = { source: "workspace-file", workspacePath };
    set({
      mainView: "document",
      activeDocumentTarget: target,
      openedDocumentState: null,
      viewBeforeDocument,
    });

    const giveUp = (err: unknown) => {
      if (!sameDocumentTarget(get().activeDocumentTarget, target)) {
        return;
      }
      set({
        mainView: viewBeforeDocument,
        activeDocumentTarget: null,
        openedDocumentState: null,
      });
      if (isWorkspaceFileRouteMissing(err)) {
        // The assistant beside this bundle has no file-backed document route,
        // so the file opens where every version can show it. No toast: nothing
        // went wrong from the reader's side.
        void openWorkspaceFile(workspacePath);
        return;
      }
      toast.error(workspaceDocumentErrorMessage(err));
    };

    try {
      const { data: result } = await documentsForworkspacefilePost({
        path: { assistant_id: assistantId },
        body: { path: workspacePath, conversationId },
        throwOnError: true,
      });
      if (!sameDocumentTarget(get().activeDocumentTarget, target)) {
        return;
      }
      if (!result) {
        giveUp(null);
        return;
      }
      set({
        // The surface id exists now, so the target becomes the same one a
        // document opened from the transcript carries.
        activeDocumentTarget: {
          source: "document",
          surfaceId: result.surfaceId,
        },
        openedDocumentState: {
          source: "document",
          surfaceId: result.surfaceId,
          conversationId: result.conversationId,
          documentName: result.title || "Untitled",
          content: result.content ?? "",
          workspacePath: result.workspacePath,
        },
      });
      useUnseenDocumentChangesStore
        .getState()
        .clearDocumentEverywhere(result.surfaceId);
    } catch (err) {
      giveUp(err);
    }
  },

  openWorkspaceFilePreview: (workspacePath, previewKind) => {
    set({
      mainView: "document",
      activeDocumentTarget: { source: "workspace-file-preview", workspacePath },
      openedDocumentState: {
        source: "workspace-file-preview",
        workspacePath,
        documentName: workspaceBasenameOf(workspacePath),
        previewKind,
      },
      viewBeforeDocument: resolveViewBefore(get(), "viewBeforeDocument"),
    });
  },

  setLoadedDocument: (document) => {
    set({ openedDocumentState: document });
  },

  updateDocumentContent: (surfaceId, content, mode) => {
    const prev = get().openedDocumentState;
    // Streamed edits address a document surface, so they never apply to a
    // read-only preview.
    if (!prev || prev.source !== "document" || prev.surfaceId !== surfaceId) {
      return;
    }
    const newContent = mode === "append" ? prev.content + content : content;
    set({ openedDocumentState: { ...prev, content: newContent } });
  },

  handleDocumentLoadFailed: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentTarget: null,
      openedDocumentState: null,
    });
  },

  closeDocument: () => {
    set({
      mainView: get().viewBeforeDocument,
      activeDocumentTarget: null,
      openedDocumentState: null,
    });
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

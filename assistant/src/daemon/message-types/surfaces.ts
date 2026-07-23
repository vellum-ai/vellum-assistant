// Surface types, UI surface lifecycle messages.

import type {
  AnySurfaceData,
  CardSurfaceData,
  ChoiceSurfaceData,
  ConfirmationSurfaceData,
  CopyBlockSurfaceData,
  DocumentPreviewSurfaceData,
  DynamicPageSurfaceData,
  FileUploadSurfaceData,
  FormSurfaceData,
  ListSurfaceData,
  OAuthConnectSurfaceData,
  SurfaceData,
  SurfaceDataByType,
  SurfaceType,
  TableSurfaceData,
  WorkResultSurfaceData,
} from "../../api/surfaces.js";

// Surface `data` shapes are wire payloads owned by `@vellumai/assistant-api`
// (`api/surfaces.ts`) — one canonical Zod schema per surface type, with the
// types inferred from the schemas. Re-exported so the daemon's surface
// protocol barrel (`message-protocol.ts`) keeps surfacing them to daemon
// consumers under their canonical names.
export {
  CardSurfaceDataSchema,
  type ChoiceOption,
  ChoiceSurfaceDataSchema,
  ConfirmationSurfaceDataSchema,
  CopyBlockSurfaceDataSchema,
  DocumentPreviewSurfaceDataSchema,
  type DynamicPagePreview,
  DynamicPageSurfaceDataSchema,
  FileUploadSurfaceDataSchema,
  type FormField,
  type FormPage,
  FormSurfaceDataSchema,
  type ListItem,
  ListSurfaceDataSchema,
  OAuthConnectSurfaceDataSchema,
  safeParseSurfaceData,
  SURFACE_TYPES,
  SurfaceTypeSchema,
  type TableCellValue,
  type TableColumn,
  type TableRow,
  TableSurfaceDataSchema,
  type WorkResultDiff,
  type WorkResultItem,
  type WorkResultMetadata,
  type WorkResultMetric,
  type WorkResultSection,
  type WorkResultSectionType,
  type WorkResultStatus,
  WorkResultSurfaceDataSchema,
  type WorkResultTone,
} from "../../api/surfaces.js";
export type {
  AnySurfaceData,
  CardSurfaceData,
  ChoiceSurfaceData,
  ConfirmationSurfaceData,
  CopyBlockSurfaceData,
  DocumentPreviewSurfaceData,
  DynamicPageSurfaceData,
  FileUploadSurfaceData,
  FormSurfaceData,
  ListSurfaceData,
  OAuthConnectSurfaceData,
  SurfaceData,
  SurfaceDataByType,
  SurfaceType,
  TableSurfaceData,
  WorkResultSurfaceData,
};

// === Surface type definitions ===

export const INTERACTIVE_SURFACE_TYPES: SurfaceType[] = [
  "choice",
  "oauth_connect",
  "form",
  "confirmation",
  "dynamic_page",
  "file_upload",
  "task_preferences",
];

export interface SurfaceAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "destructive";
  /** Optional data payload returned to the daemon when this action is clicked. */
  data?: Record<string, unknown>;
}

// === Client → Server ===

export interface UiSurfaceAction {
  type: "ui_surface_action";
  conversationId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
}

export interface UiSurfaceUndoRequest {
  type: "ui_surface_undo";
  conversationId: string;
  surfaceId: string;
}

// === Server → Client ===

/** Common fields shared by all UiSurfaceShow variants. */
interface UiSurfaceShowBase {
  type: "ui_surface_show";
  conversationId: string;
  surfaceId: string;
  title?: string;
  actions?: SurfaceAction[];
  display?: "inline" | "panel";
  /** The message ID that this surface belongs to (for history loading). */
  messageId?: string;
  /** When `true`, clicking an action does not dismiss the surface — the client keeps the card visible and only marks the clicked `actionId` as spent so siblings remain clickable. */
  persistent?: boolean;
  /** Id of the tool call that produced this surface (the `ui_show` proxy tool). Lets the client gate app previews on the tool result's arrival rather than whole-turn streaming state. */
  toolCallId?: string;
}

/**
 * The show event for one specific surface type: base fields plus the
 * correlated `surfaceType`/`data` pair, both indexed from
 * `SurfaceDataByType` so generic code keeps the pairing.
 */
export type UiSurfaceShowFor<K extends SurfaceType> = UiSurfaceShowBase & {
  surfaceType: K;
  data: SurfaceDataByType[K];
};

/**
 * Discriminated union over every surface type, derived from
 * `SurfaceDataByType` so a type added there appears here automatically.
 * Includes the opaque types (`channel_setup`, `task_preferences`) — their
 * show events carry opaque record data.
 */
export type UiSurfaceShow = {
  [K in SurfaceType]: UiSurfaceShowFor<K>;
}[SurfaceType];

export type UiSurfaceShowCard = UiSurfaceShowFor<"card">;
export type UiSurfaceShowChoice = UiSurfaceShowFor<"choice">;
export type UiSurfaceShowCopyBlock = UiSurfaceShowFor<"copy_block">;
export type UiSurfaceShowOAuthConnect = UiSurfaceShowFor<"oauth_connect">;
export type UiSurfaceShowForm = UiSurfaceShowFor<"form">;
export type UiSurfaceShowList = UiSurfaceShowFor<"list">;
export type UiSurfaceShowConfirmation = UiSurfaceShowFor<"confirmation">;
export type UiSurfaceShowDynamicPage = UiSurfaceShowFor<"dynamic_page">;
export type UiSurfaceShowTable = UiSurfaceShowFor<"table">;
export type UiSurfaceShowFileUpload = UiSurfaceShowFor<"file_upload">;
export type UiSurfaceShowDocumentPreview = UiSurfaceShowFor<"document_preview">;
export type UiSurfaceShowWorkResult = UiSurfaceShowFor<"work_result">;

export interface UiSurfaceUpdate {
  type: "ui_surface_update";
  conversationId: string;
  surfaceId: string;
  data: Partial<AnySurfaceData>;
}

export interface UiSurfaceDismiss {
  type: "ui_surface_dismiss";
  conversationId: string;
  surfaceId: string;
}

export interface UiSurfaceComplete {
  type: "ui_surface_complete";
  conversationId: string;
  surfaceId: string;
  summary: string;
  submittedData?: Record<string, unknown>;
}

export interface UiSurfaceUndoResult {
  type: "ui_surface_undo_result";
  conversationId: string;
  surfaceId: string;
  success: boolean;
  /** Number of remaining undo entries after this undo. */
  remainingUndos: number;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SurfacesClientMessages = UiSurfaceAction | UiSurfaceUndoRequest;

export type _SurfacesServerMessages =
  | UiSurfaceShow
  | UiSurfaceUpdate
  | UiSurfaceDismiss
  | UiSurfaceComplete
  | UiSurfaceUndoResult;

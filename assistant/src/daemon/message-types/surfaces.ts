// Surface types, UI surface lifecycle messages.

import type { UISurfaceCompleteEvent } from "../../api/events/ui-surface-complete.js";
import type { UISurfaceDismissEvent } from "../../api/events/ui-surface-dismiss.js";
import type { UISurfaceShowEvent } from "../../api/events/ui-surface-show.js";
import type { UISurfaceUndoResultEvent } from "../../api/events/ui-surface-undo-result.js";
import type { UISurfaceUpdateEvent } from "../../api/events/ui-surface-update.js";
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

// The clickable-action shape and the five surface lifecycle events are
// single-sourced from their canonical `api/events` wire schemas; re-exported so
// the daemon's surface protocol barrel keeps surfacing them under their
// canonical names.
export type { SurfaceAction } from "../../api/events/ui-surface-show.js";
export type {
  UISurfaceCompleteEvent,
  UISurfaceDismissEvent,
  UISurfaceShowEvent,
  UISurfaceUndoResultEvent,
  UISurfaceUpdateEvent,
};

// Surface actions (user clicks) and undo requests are served by the HTTP
// surface-action routes (`surface-actions`, `surfaces/:id/undo`), not by client
// messages.

// === Server → Client ===

/**
 * The show event for one specific surface type: the canonical
 * `UISurfaceShowEvent` base fields with the wire-opaque `surfaceType`/`data`
 * replaced by the correlated pair indexed from `SurfaceDataByType`, so daemon
 * construction code keeps the `surfaceType` ↔ `data` pairing that the opaque
 * wire schema deliberately drops. Assignable to `UISurfaceShowEvent`.
 */
export type UiSurfaceShowFor<K extends SurfaceType> = Omit<
  UISurfaceShowEvent,
  "surfaceType" | "data"
> & {
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

// All five surface lifecycle events are single-sourced from their canonical
// `api/events` wire schemas. The strict, per-`surfaceType` `UiSurfaceShow*`
// types above are daemon-side construction helpers derived from the same
// canonical `UISurfaceShowEvent` — they narrow `surfaceType` ↔ `data` for
// typed construction and are assignable to the opaque wire type.

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SurfacesServerMessages =
  | UISurfaceShowEvent
  | UISurfaceUpdateEvent
  | UISurfaceDismissEvent
  | UISurfaceCompleteEvent
  | UISurfaceUndoResultEvent;

/**
 * Canonical surface-data wire payloads.
 *
 * The `ui_surface_*` events and the conversation-message response all carry a
 * surface `data` object whose shape depends on `surfaceType`. The wire keeps
 * `data` opaque (`z.record`) — see `events/ui-surface-show.ts` for why — so
 * consumers narrow it by parsing with the canonical per-type schema here. The
 * schemas are deliberately tolerant (every field optional, Zod strip mode): a
 * parse miss makes a renderable surface silently vanish, so they must never
 * reject a real payload. The schema also defines what the daemon's `ui_show`
 * normalizer *supports* — anything the model sends outside these fields is
 * dropped (and logged) there, which is how we learn the shapes to recover.
 *
 * Every surface type has a canonical schema here; the daemon's
 * `daemon/message-types/surfaces.ts` re-exports the inferred types under
 * their canonical names, and `safeParseSurfaceData` dispatches a payload
 * to its `surface_type`'s schema so entry points (`surfaceProxyResolver`)
 * can parse instead of casting.
 */

import { z } from "zod";

/**
 * Local plain-object check. This package is copied verbatim into consumer
 * node_modules, so it must not import helpers from outside `api/`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a surface `data` payload to a plain object. Models sometimes
 * double-encode the nested `data` argument as a JSON string
 * (`"data": "{\"text\": ...}"`); rejecting that shape discards an otherwise
 * valid payload, so parse it back into an object here. Anything else that
 * isn't a plain object collapses to `{}`.
 */
export function coerceSurfaceDataRecord(
  value: unknown,
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON — fall through to the empty-object default.
    }
  }
  return {};
}

/** Optional string that drops (rather than rejects on) a non-string value. */
const tolerantString = () => z.string().optional().catch(undefined);

/** Optional boolean that drops (rather than rejects on) a non-boolean value. */
const tolerantBoolean = () => z.boolean().optional().catch(undefined);

/** Optional finite number that drops (rather than rejects on) anything else. */
const tolerantNumber = () => z.number().finite().optional().catch(undefined);

/**
 * Array of records: a non-array collapses to `[]` and non-object entries are
 * dropped, so one malformed entry never rejects the whole surface.
 */
function recordArray<T extends z.ZodType>(entry: T) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value.filter(isRecord) : []),
    z.array(entry),
  );
}

export const CardSurfaceDataSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  metadata: z
    .array(z.object({ label: z.coerce.string(), value: z.coerce.string() }))
    .optional(),
  /** Optional template name for specialized rendering (e.g. "weather_forecast"). */
  template: z.string().optional(),
  /** Arbitrary data consumed by the template renderer. Shape depends on template. */
  templateData: z.record(z.string(), z.unknown()).optional(),
});
export type CardSurfaceData = z.infer<typeof CardSurfaceDataSchema>;

/**
 * Accepted MIME-type / extension patterns for a `file_upload` surface.
 *
 * The renderer consumes this as a `string[]` — it calls `.join`/`.some`/
 * `.length` on the value — but the model may emit a single comma-joined string
 * ("image/*, application/pdf") or a bare string. Coercing every shape to a
 * clean `string[]` keeps that array invariant intact: a string is split on
 * commas; array entries are stringified and trimmed; blanks and any non-array
 * value collapse to `undefined` (no restriction).
 */
const FileUploadAcceptedTypesSchema = z.preprocess((value) => {
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : [];
  const cleaned = items
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item).trim()
        : "",
    )
    .filter((item) => item.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}, z.array(z.string()).optional());

export const FileUploadSurfaceDataSchema = z.object({
  prompt: z.coerce.string().optional(),
  acceptedTypes: FileUploadAcceptedTypesSchema,
  /** A non-positive or non-numeric value is dropped rather than rejecting the surface. */
  maxFiles: z.coerce.number().int().positive().optional().catch(undefined),
  maxSizeBytes: z.coerce.number().positive().optional().catch(undefined),
});
export type FileUploadSurfaceData = z.infer<typeof FileUploadSurfaceDataSchema>;

export const CopyBlockSurfaceDataSchema = z.object({
  /** The copyable text. Load-bearing: an empty string renders a blank block. */
  text: z.string().catch(""),
  label: tolerantString(),
  language: tolerantString(),
});
export type CopyBlockSurfaceData = z.infer<typeof CopyBlockSurfaceDataSchema>;

/**
 * Normalize a copy_block `ui_show` payload: recover fields the model placed
 * at the top level of the tool input instead of nesting inside `data`, then
 * parse through the canonical schema. Shared by the tool's teaching guard and
 * the daemon resolver so both layers accept exactly the same payloads.
 */
export function normalizeCopyBlockShowData(
  input: Record<string, unknown>,
  data: Record<string, unknown>,
): CopyBlockSurfaceData {
  const normalized: Record<string, unknown> = { ...data };
  for (const key of ["text", "label", "language"] as const) {
    if (typeof normalized[key] !== "string" && typeof input[key] === "string") {
      normalized[key] = input[key];
    }
  }
  return CopyBlockSurfaceDataSchema.parse(normalized);
}

export const ChoiceOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: tolerantString(),
  /** Visually highlight this option as the assistant's recommendation. */
  recommended: tolerantBoolean(),
  /** Optional structured payload returned with this choice. */
  data: z.record(z.string(), z.unknown()).optional().catch(undefined),
});
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

/**
 * Choice options with recovery: `label` is accepted as a `title` alias,
 * `id`/`title` are trimmed, and entries missing either are dropped rather
 * than rejecting the surface.
 */
const ChoiceOptionsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const title =
      typeof option.title === "string"
        ? option.title.trim()
        : typeof option.label === "string"
          ? option.label.trim()
          : "";
    if (!id || !title) {
      return [];
    }
    return [{ ...option, id, title }];
  });
}, z.array(ChoiceOptionSchema));

export const ChoiceSurfaceDataSchema = z.object({
  description: tolerantString(),
  options: ChoiceOptionsSchema,
  /** Anything other than "multiple" (including absence) means single-select. */
  selectionMode: z.preprocess(
    (value) => (value === "multiple" ? "multiple" : "single"),
    z.enum(["single", "multiple"]),
  ),
  /**
   * When true, clicking an option submits it immediately. Defaults to true for
   * single-select choice surfaces.
   */
  commitOnSelect: tolerantBoolean(),
  submitLabel: tolerantString(),
});
export type ChoiceSurfaceData = z.infer<typeof ChoiceSurfaceDataSchema>;

export const OAuthConnectSurfaceDataSchema = z.object({
  /** OAuth provider key from the managed provider catalog, e.g. "google". */
  providerKey: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim() : value),
      z.string(),
    )
    .catch(""),
  /** Optional display label. The client falls back to the provider catalog. */
  displayName: tolerantString(),
  /** Optional helper text. The client falls back to the provider catalog. */
  description: tolerantString(),
  /** Optional provider logo URL. The client falls back to the provider catalog. */
  logoUrl: z.string().nullable().optional().catch(undefined),
});
export type OAuthConnectSurfaceData = z.infer<
  typeof OAuthConnectSurfaceDataSchema
>;

export const FormFieldSchema = z.object({
  id: z.string().catch(""),
  type: z
    .enum(["text", "textarea", "select", "toggle", "number", "password"])
    .catch("text"),
  label: z.string().catch(""),
  placeholder: tolerantString(),
  required: tolerantBoolean(),
  defaultValue: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .catch(undefined),
  options: z
    .array(z.object({ label: z.coerce.string(), value: z.coerce.string() }))
    .optional()
    .catch(undefined),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const FormPageSchema = z.object({
  id: z.string().catch(""),
  title: z.string().catch(""),
  description: tolerantString(),
  fields: recordArray(FormFieldSchema),
});
export type FormPage = z.infer<typeof FormPageSchema>;

export const FormSurfaceDataSchema = z.object({
  description: tolerantString(),
  fields: recordArray(FormFieldSchema),
  submitLabel: tolerantString(),
  pages: recordArray(FormPageSchema).optional().catch(undefined),
  pageLabels: z
    .object({
      next: tolerantString(),
      back: tolerantString(),
      submit: tolerantString(),
    })
    .optional()
    .catch(undefined),
  /** Progress indicator style for multi-page forms: segment bar or labeled tabs. */
  progressStyle: z.enum(["bar", "tabs"]).optional().catch(undefined),
});
export type FormSurfaceData = z.infer<typeof FormSurfaceDataSchema>;

export const ListItemSchema = z.object({
  id: z.string().catch(""),
  title: z.string().catch(""),
  subtitle: tolerantString(),
  icon: tolerantString(),
  selected: tolerantBoolean(),
});
export type ListItem = z.infer<typeof ListItemSchema>;

export const ListSurfaceDataSchema = z.object({
  items: recordArray(ListItemSchema),
  selectionMode: z.enum(["single", "multiple", "none"]).catch("none"),
});
export type ListSurfaceData = z.infer<typeof ListSurfaceDataSchema>;

export const TableColumnSchema = z.object({
  id: z.string().catch(""),
  label: z.string().catch(""),
  width: tolerantNumber(),
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableCellValueSchema = z.object({
  text: z.coerce.string().catch(""),
  /** SF Symbol name. */
  icon: tolerantString(),
  /** Semantic token: "success" | "warning" | "error" | "muted". */
  iconColor: tolerantString(),
});
export type TableCellValue = z.infer<typeof TableCellValueSchema>;

export const TableRowSchema = z.object({
  id: z.string().catch(""),
  /** A malformed cell value collapses to "" rather than rejecting the row. */
  cells: z
    .record(z.string(), z.union([z.string(), TableCellValueSchema]).catch(""))
    .catch({}),
  selectable: tolerantBoolean(),
  selected: tolerantBoolean(),
});
export type TableRow = z.infer<typeof TableRowSchema>;

export const TableSurfaceDataSchema = z.object({
  columns: recordArray(TableColumnSchema),
  rows: recordArray(TableRowSchema),
  selectionMode: z
    .enum(["none", "single", "multiple"])
    .optional()
    .catch(undefined),
  caption: tolerantString(),
});
export type TableSurfaceData = z.infer<typeof TableSurfaceDataSchema>;

export const ConfirmationSurfaceDataSchema = z.object({
  /** The confirmation prompt. Load-bearing: empty renders a blank card. */
  message: z.string().catch(""),
  detail: tolerantString(),
  confirmLabel: tolerantString(),
  confirmedLabel: tolerantString(),
  cancelLabel: tolerantString(),
  destructive: tolerantBoolean(),
});
export type ConfirmationSurfaceData = z.infer<
  typeof ConfirmationSurfaceDataSchema
>;

export const DynamicPagePreviewSchema = z.object({
  title: z.string().catch(""),
  subtitle: tolerantString(),
  description: tolerantString(),
  icon: tolerantString(),
  metrics: z
    .array(z.object({ label: z.coerce.string(), value: z.coerce.string() }))
    .optional()
    .catch(undefined),
  context: z.enum(["app_create", "general"]).optional().catch(undefined),
  /** base64 PNG */
  previewImage: tolerantString(),
});
export type DynamicPagePreview = z.infer<typeof DynamicPagePreviewSchema>;

export const DynamicPageSurfaceDataSchema = z.object({
  /** The page markup. Load-bearing: empty renders a blank box. */
  html: z.string().catch(""),
  width: tolerantNumber(),
  height: tolerantNumber(),
  appId: tolerantString(),
  /** Filesystem directory name for this app (may differ from `appId`). */
  dirName: tolerantString(),
  reloadGeneration: tolerantNumber(),
  status: tolerantString(),
  preview: DynamicPagePreviewSchema.optional().catch(undefined),
});
export type DynamicPageSurfaceData = z.infer<
  typeof DynamicPageSurfaceDataSchema
>;

export const DocumentPreviewSurfaceDataSchema = z.object({
  title: z.string().catch(""),
  /** The document's real surfaceId, for focusing the panel. */
  surfaceId: z.string().catch(""),
  subtitle: tolerantString(),
});
export type DocumentPreviewSurfaceData = z.infer<
  typeof DocumentPreviewSurfaceDataSchema
>;

export const WorkResultStatusSchema = z.enum([
  "completed",
  "partial",
  "failed",
  "in_progress",
]);
export type WorkResultStatus = z.infer<typeof WorkResultStatusSchema>;

export const WorkResultToneSchema = z.enum([
  "neutral",
  "positive",
  "warning",
  "negative",
]);
export type WorkResultTone = z.infer<typeof WorkResultToneSchema>;

export const WorkResultSectionTypeSchema = z.enum([
  "items",
  "timeline",
  "diff",
  "artifacts",
  "warnings",
]);
export type WorkResultSectionType = z.infer<typeof WorkResultSectionTypeSchema>;

const workResultLabelValue = () => ({
  label: z.coerce.string().catch(""),
  value: z.union([z.string(), z.number()]).catch(""),
});

export const WorkResultMetricSchema = z.object({
  ...workResultLabelValue(),
  detail: tolerantString(),
  tone: WorkResultToneSchema.optional().catch(undefined),
});
export type WorkResultMetric = z.infer<typeof WorkResultMetricSchema>;

export const WorkResultMetadataSchema = z.object(workResultLabelValue());
export type WorkResultMetadata = z.infer<typeof WorkResultMetadataSchema>;

export const WorkResultItemSchema = z.object({
  id: tolerantString(),
  title: z.coerce.string().catch(""),
  description: tolerantString(),
  status: tolerantString(),
  tone: WorkResultToneSchema.optional().catch(undefined),
  metadata: recordArray(WorkResultMetadataSchema).optional().catch(undefined),
  href: tolerantString(),
});
export type WorkResultItem = z.infer<typeof WorkResultItemSchema>;

export const WorkResultDiffSchema = z.object({
  label: tolerantString(),
  before: tolerantString(),
  after: tolerantString(),
});
export type WorkResultDiff = z.infer<typeof WorkResultDiffSchema>;

export const WorkResultSectionSchema = z.object({
  id: tolerantString(),
  title: z.coerce.string().catch(""),
  description: tolerantString(),
  type: WorkResultSectionTypeSchema.optional().catch(undefined),
  items: recordArray(WorkResultItemSchema).optional().catch(undefined),
  diffs: recordArray(WorkResultDiffSchema).optional().catch(undefined),
});
export type WorkResultSection = z.infer<typeof WorkResultSectionSchema>;

export const WorkResultSurfaceDataSchema = z.object({
  eyebrow: tolerantString(),
  status: WorkResultStatusSchema.optional().catch(undefined),
  summary: tolerantString(),
  metrics: recordArray(WorkResultMetricSchema).optional().catch(undefined),
  sections: recordArray(WorkResultSectionSchema).optional().catch(undefined),
});
export type WorkResultSurfaceData = z.infer<typeof WorkResultSurfaceDataSchema>;

// === Surface type registry ===

export const SURFACE_TYPES = [
  "card",
  "channel_setup",
  "choice",
  "copy_block",
  "oauth_connect",
  "form",
  "list",
  "table",
  "confirmation",
  "dynamic_page",
  "file_upload",
  "document_preview",
  "task_preferences",
  "work_result",
  "skill_card",
  "call_summary",
] as const;

export const SurfaceTypeSchema = z.enum(SURFACE_TYPES);
export type SurfaceType = z.infer<typeof SurfaceTypeSchema>;

/**
 * Surface types the daemon emits and persists directly (the memory
 * retrospective's `skill_card`, a call's `call_summary`) but that the model
 * must never invoke via `ui_show`. They are members of `SurfaceType` so the
 * persistence/restore path can carry them, but they are deliberately absent
 * from the model-facing `ui_show` surface list (`SURFACE_SHAPE_DOCS`), and
 * the `ui_show` resolver rejects them.
 */
export const DAEMON_INTERNAL_SURFACE_TYPES = [
  "skill_card",
  "call_summary",
] as const;

const DAEMON_INTERNAL_SURFACE_TYPE_SET = new Set<string>(
  DAEMON_INTERNAL_SURFACE_TYPES,
);

/** Whether `type` is a daemon-internal surface type the model must not `ui_show`. */
export function isDaemonInternalSurfaceType(type: string): boolean {
  return DAEMON_INTERNAL_SURFACE_TYPE_SET.has(type);
}

/** Surface types the model may request via `ui_show` (internal types excluded). */
export const MODEL_INVOKABLE_SURFACE_TYPES = SURFACE_TYPES.filter(
  (type) => !isDaemonInternalSurfaceType(type),
);

export type SurfaceData =
  | CardSurfaceData
  | ChoiceSurfaceData
  | CopyBlockSurfaceData
  | OAuthConnectSurfaceData
  | FormSurfaceData
  | ListSurfaceData
  | TableSurfaceData
  | ConfirmationSurfaceData
  | DynamicPageSurfaceData
  | FileUploadSurfaceData
  | DocumentPreviewSurfaceData
  | WorkResultSurfaceData;

/**
 * Per-type `data` payload shapes, keyed by surface type. This is the
 * correlation source for everything that pairs a `surfaceType` with its
 * `data`: generic code indexes it (`SurfaceDataByType[K]`) so the compiler
 * tracks which data shape belongs to which type instead of collapsing to
 * the undiscriminated `SurfaceData` union.
 *
 * Several types are opaque records — they carry data the daemon persists
 * and serves verbatim but whose shape it does not model, which is why they
 * are absent from the renderable `SurfaceData` union: `channel_setup` (a
 * side-effect command forwarded to the setup panel), `task_preferences` (a
 * fixed grid that reads no data), and `skill_card` / `call_summary` (cards
 * the daemon appends to history directly — the memory retrospective and a
 * call summary — and whose data shape is owned by their client renderers).
 */
export interface SurfaceDataByType {
  card: CardSurfaceData;
  channel_setup: Record<string, unknown>;
  choice: ChoiceSurfaceData;
  copy_block: CopyBlockSurfaceData;
  oauth_connect: OAuthConnectSurfaceData;
  form: FormSurfaceData;
  list: ListSurfaceData;
  table: TableSurfaceData;
  confirmation: ConfirmationSurfaceData;
  dynamic_page: DynamicPageSurfaceData;
  file_upload: FileUploadSurfaceData;
  document_preview: DocumentPreviewSurfaceData;
  task_preferences: Record<string, unknown>;
  work_result: WorkResultSurfaceData;
  skill_card: Record<string, unknown>;
  call_summary: Record<string, unknown>;
}

/** Any surface `data` payload, including the opaque (non-renderable) types. */
export type AnySurfaceData = SurfaceDataByType[SurfaceType];

/**
 * Canonical schema per surface type. The mapped type is what makes generic
 * indexing sound: `SURFACE_DATA_SCHEMAS[t]` for `t: K` has type
 * `z.ZodType<SurfaceDataByType[K]>`, so parse results stay correlated with
 * the surface type instead of widening to an untyped union — the compiler
 * also verifies here, entry by entry, that each schema's output matches its
 * declared payload shape.
 */
export const SURFACE_DATA_SCHEMAS: {
  [K in SurfaceType]: z.ZodType<SurfaceDataByType[K]>;
} = {
  card: CardSurfaceDataSchema,
  channel_setup: z.record(z.string(), z.unknown()),
  choice: ChoiceSurfaceDataSchema,
  copy_block: CopyBlockSurfaceDataSchema,
  oauth_connect: OAuthConnectSurfaceDataSchema,
  form: FormSurfaceDataSchema,
  list: ListSurfaceDataSchema,
  table: TableSurfaceDataSchema,
  confirmation: ConfirmationSurfaceDataSchema,
  dynamic_page: DynamicPageSurfaceDataSchema,
  file_upload: FileUploadSurfaceDataSchema,
  document_preview: DocumentPreviewSurfaceDataSchema,
  task_preferences: z.record(z.string(), z.unknown()),
  work_result: WorkResultSurfaceDataSchema,
  skill_card: z.record(z.string(), z.unknown()),
  call_summary: z.record(z.string(), z.unknown()),
};

/**
 * Parse a surface `data` payload through its type's canonical schema,
 * returning `undefined` when the payload does not parse.
 *
 * Only `card` can actually fail on an object input (its fields validate
 * without `catch` fallbacks); every other schema is total over plain
 * objects, and a non-object payload fails them all.
 */
export function safeParseSurfaceData<K extends SurfaceType>(
  surfaceType: K,
  data: unknown,
): SurfaceDataByType[K] | undefined {
  const result = SURFACE_DATA_SCHEMAS[surfaceType].safeParse(data);
  return result.success ? result.data : undefined;
}

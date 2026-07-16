/**
 * Point-of-use shape documentation and essential-content guards for ui_show
 * surfaces.
 *
 * Each entry documents one surface type: a one-phrase `purpose` (used in the
 * unknown-type index error) and the full data `shape` spec (returned inside a
 * teaching error when a payload is missing its load-bearing content). Keeping
 * the specs here rather than in the always-present tool description lets the
 * model recover the exact shape at the moment it gets one wrong.
 *
 * Guards are advisory and intentionally minimal: they check only the fields
 * without which the surface renders blank or broken (mirroring the tolerant
 * contract in `api/surfaces.ts` — a renderable payload must never be
 * rejected). Normalization the daemon already performs (e.g. top-level
 * `template`/`title` lifted into card data by `normalizeCardShowData`) must
 * stay accepted, so card has no guard here.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a value carries any renderable content: a non-empty string, a
 * non-empty array, a non-empty primitive, or an object with at least one
 * content-bearing value (recursively).
 */
export function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasContent);
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

interface SurfaceShapeDoc {
  /** One-phrase purpose, shown in the unknown-surface_type index error. */
  purpose: string;
  /** Full `data` shape spec, shown in per-type teaching errors. */
  shape: string;
  /**
   * Returns a description of the missing load-bearing content, or null when
   * the payload has enough to render. Absent for types the daemon normalizes
   * leniently (card), that render fine with defaults (file_upload), or that
   * have bespoke handling (dynamic_page).
   */
  missingContent?: (data: Record<string, unknown>) => string | null;
}

/** templateData shape of a task_progress card (shared with channel variants). */
export const TASK_PROGRESS_TEMPLATE_SHAPE =
  '{ title, status: "in_progress"|"completed"|"failed", steps: [{ label, status: "pending"|"in_progress"|"completed"|"failed", detail? }] }';

export const SURFACE_SHAPE_DOCS: Record<string, SurfaceShapeDoc> = {
  card: {
    purpose: "structured info card, supports templates like task_progress",
    shape: `{ title, subtitle?, body, metadata?: [{ label, value }], template?, templateData? }. Template "task_progress" renders a live step tracker — templateData: ${TASK_PROGRESS_TEMPLATE_SHAPE}; advance it via ui_update as steps finish. Other card templates are documented by the skills that use them`,
  },
  copy_block: {
    purpose: "copyable text with a visible copy button",
    shape:
      "{ text, label?, language? } — shows copyable text with a visible copy button; use for prompts, commands, paths, or snippets the user should copy",
    missingContent: (data) =>
      isNonEmptyString(data.text)
        ? null
        : "`data.text` must be a non-empty string",
  },
  choice: {
    purpose: "clickable options for the user to pick from",
    shape:
      '{ description?, options: [{ id, title, description?, recommended?, data? }], selectionMode?: "single"|"multiple", commitOnSelect?, submitLabel? }. Single-select choices commit on option click by default; mark the strongest option with recommended: true',
    missingContent: (data) =>
      isNonEmptyArray(data.options)
        ? null
        : "`data.options` must be a non-empty array",
  },
  table: {
    purpose: "tabular data, optionally with selectable rows",
    shape:
      '{ columns: [{ id, label }], rows: [{ id, cells: Record<columnId, string | { text, icon?, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?, selected? }], selectionMode?: "none"|"single"|"multiple", caption? }',
    missingContent: (data) =>
      isNonEmptyArray(data.columns)
        ? null
        : "`data.columns` must be a non-empty array",
  },
  work_result: {
    purpose: "structured receipt after completed work",
    shape:
      '{ eyebrow?, status?: "completed"|"partial"|"failed"|"in_progress", summary?, metrics?: [{ label, value, detail?, tone?: "neutral"|"positive"|"warning"|"negative" }], sections?: [{ id?, title, description?, type?: "items"|"timeline"|"diff"|"artifacts"|"warnings", items?: [{ id?, title, description?, status?, tone?, metadata?: [{ label, value }], href? }], diffs?: [{ label?, before?, after? }] }] } — structured receipt after real work; keep display-only unless follow-up buttons are needed',
    missingContent: (data) =>
      hasContent(data)
        ? null
        : "`data` must carry at least a summary, metrics, or sections",
  },
  oauth_connect: {
    purpose: "managed OAuth connection button for an integration account",
    shape:
      "{ providerKey, displayName?, description?, logoUrl? } — managed OAuth connection CTA; use when the task needs a managed integration account (Google, Linear, GitHub, ...) instead of settings or shell OAuth. Do not include OAuth scopes; managed providers use the platform's configured scopes",
    missingContent: (data) =>
      isNonEmptyString(data.providerKey)
        ? null
        : "`data.providerKey` must name the provider to connect",
  },
  form: {
    purpose: "input form, single or multi-page",
    shape:
      '{ description?, fields: [{ id, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label, placeholder?, required?, defaultValue?, options?: [{ label, value }] }], submitLabel? }. Multi-page: { pages: [{ id, title, description?, fields }], pageLabels?: { next?, back?, submit? }, submitLabel? }',
    missingContent: (data) =>
      isNonEmptyArray(data.fields) || isNonEmptyArray(data.pages)
        ? null
        : "`data.fields` (or `data.pages`) must be a non-empty array",
  },
  confirmation: {
    purpose: "confirm/cancel prompt",
    shape:
      "{ message, detail?, confirmLabel?, confirmedLabel?, cancelLabel?, destructive? }",
    missingContent: (data) =>
      isNonEmptyString(data.message)
        ? null
        : "`data.message` must be a non-empty string",
  },
  file_upload: {
    purpose: "prompt the user to upload files",
    shape: "{ prompt, acceptedTypes?, maxFiles? }",
  },
  dynamic_page: {
    purpose: "custom HTML page for transient UI only, never app-like builds",
    shape:
      "{ html, width?, height?, preview?: { title, subtitle?, description?, icon?, metrics?: [{ label, value }] } } — custom visual HTML for transient surfaces only, never app-like builds",
  },
  channel_setup: {
    purpose: "open the Slack/Telegram/Phone setup panel",
    shape: '{ channel: "slack" | "telegram" | "phone" }',
    missingContent: (data) =>
      data.channel === "slack" ||
      data.channel === "telegram" ||
      data.channel === "phone"
        ? null
        : '`data.channel` must be one of "slack", "telegram", "phone"',
  },
};

/** Model-facing surface_type enum, derived so docs and schema cannot drift. */
export const SURFACE_TYPE_NAMES = Object.keys(SURFACE_SHAPE_DOCS);

const SURFACE_TYPE_INDEX = SURFACE_TYPE_NAMES.map(
  (name) => `${name} (${SURFACE_SHAPE_DOCS[name]!.purpose})`,
).join("; ");

/**
 * Types whose full shape rides in the always-present tool description —
 * together they cover ~95% of fleet ui_show calls. The rest appear there as
 * a one-line index and get their shape from the teaching error on first
 * misuse.
 */
const HOT_SURFACE_TYPES = [
  "card",
  "copy_block",
  "choice",
  "table",
  "work_result",
  "oauth_connect",
  "dynamic_page",
] as const;

const COLD_SURFACE_INDEX = SURFACE_TYPE_NAMES.filter(
  (name) => !(HOT_SURFACE_TYPES as readonly string[]).includes(name),
)
  .map((name) => `${name} (${SURFACE_SHAPE_DOCS[name]!.purpose})`)
  .join(", ");

/** The surface-types section of the ui_show tool description. */
export const UI_SHOW_TYPE_DOCS = [
  "Surface types (data shapes):",
  ...HOT_SURFACE_TYPES.map(
    (name) => `- ${name}: ${SURFACE_SHAPE_DOCS[name]!.shape}`,
  ),
  `Other types: ${COLD_SURFACE_INDEX}. Send your best-guess data — if required content is missing, the error returns the exact shape.`,
].join("\n");

/**
 * Teaching error for a ui_show payload that would render nothing, or null
 * when the payload is displayable. Unknown/missing surface_type gets the
 * full type index; a known type missing its load-bearing content gets that
 * type's exact shape. dynamic_page emptiness is handled by the bespoke
 * model-aware envelopes in `definitions.ts`, not here.
 */
export function uiShowTeachingError(
  input: Record<string, unknown>,
): string | null {
  const surfaceType = input.surface_type;
  if (
    typeof surfaceType !== "string" ||
    !Object.hasOwn(SURFACE_SHAPE_DOCS, surfaceType)
  ) {
    const got =
      typeof surfaceType === "string" && surfaceType.trim().length > 0
        ? `"${surfaceType}" is not a surface type`
        : "`surface_type` is missing";
    return `Error: ui_show was not displayed — ${got}. Valid types: ${SURFACE_TYPE_INDEX}. Resend ui_show with one of these surface_type values; if a type's data is missing required content, the error will include its exact shape.`;
  }
  const doc = SURFACE_SHAPE_DOCS[surfaceType]!;
  if (!doc.missingContent) {
    return null;
  }
  const missing = doc.missingContent(asRecord(input.data) ?? {});
  if (missing === null) {
    return null;
  }
  return `Error: ui_show ${surfaceType} was not displayed — ${missing}, so the user saw nothing. Data shape: ${doc.shape}. Resend ui_show with the missing content filled in.`;
}

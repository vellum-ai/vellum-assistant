/**
 * UI surface tool definitions.
 *
 * These tools allow the model to show, update, and dismiss just-in-time UI
 * surfaces (cards, forms, lists, confirmations) on a connected macOS client.
 * They are proxy tools -- execution is forwarded to the client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from "../../permissions/types.js";
import { ACTIVATION_MOMENT_PARAMS } from "../../telemetry/activation-funnel.js";
import { isWeakOpenModel } from "../../util/weak-open-model.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_BUILDER_ARTIFACT_RE =
  /\b(app|apps|application|applications|website|websites|site|sites|dashboard|dashboards|game|games|calculator|calculators|tracker|trackers|visualization|visualizations|visualisation|visualisations|visualize|visualise|artifact|artifacts|chart|charts|graph|graphs|tool|tools|utility|utilities|counter|counters)\b/i;
const APP_BUILDER_BUILD_RE =
  /\b(build|building|built|create|creating|created|make|making|made|generate|generating|generated)\b/i;

/**
 * Forward execution to the connected macOS client via the request-bound
 * `proxyToolResolver`. Returns a structured error when no resolver is
 * configured (e.g. no client connected) so callers see a normal tool
 * failure rather than an unhandled throw.
 */
function proxyExecute(toolName: string) {
  return async (
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    if (toolName === "ui_show" && isEmptyDynamicPage(input)) {
      return {
        content: isWeakOpenModel(context.attribution?.resolvedModel)
          ? EMPTY_DYNAMIC_PAGE_DECLARATIVE_REDIRECT
          : EMPTY_DYNAMIC_PAGE_HTML_HINT,
        isError: true,
      };
    }

    if (toolName === "ui_show" && isDynamicPageAppSubstitute(input)) {
      return {
        content:
          'Error: ui_show dynamic_page is for transient UI surfaces only. This request is building an app-like experience, so load the app-builder skill first with `skill_load` using `skill: "app-builder"`, then create a persistent Library app with the app-builder workflow.',
        isError: true,
      };
    }

    if (toolName === "ui_update" && isEmptyUpdate(input)) {
      return {
        content:
          'Error: ui_update received an empty `data` payload, so the surface was unchanged — the user still sees its previous state. The provided data is merged into the surface\'s current data, and merging nothing is a no-op. To advance a task_progress card, send the full step list: ui_update { surface_id: "<id>", data: { templateData: { steps: [{ label: "<step>", status: "completed" }, { label: "<step>", status: "in_progress" }] } } }. Resend ui_update with the fields you intend to change under `data`.',
        isError: true,
      };
    }

    if (!context.proxyToolResolver) {
      return {
        content: `No proxy resolver configured for proxy tool "${toolName}". This tool requires an external resolver (e.g. a connected macOS client).`,
        isError: true,
      };
    }
    const result = await context.proxyToolResolver(toolName, input);
    if (
      toolName === "ui_show" &&
      !result.isError &&
      typeof result.content === "string" &&
      isTaskProgressCardShow(input)
    ) {
      return {
        ...result,
        content: `${result.content}\n\n${TASK_PROGRESS_UPDATE_HINT}`,
      };
    }
    return result;
  };
}

/**
 * Rejection envelope for an empty `dynamic_page` ui_show from a capable model:
 * the surface carried no `data.html`, so it would render as a blank box. These
 * models reliably author HTML, so the fix is simply to resend it inline.
 */
const EMPTY_DYNAMIC_PAGE_HTML_HINT =
  "Error: ui_show dynamic_page requires non-empty HTML in `data.html`. The surface was not displayed because no content was provided — the user would see a blank box. Resend ui_show with the full HTML markup in `data.html`.";

/**
 * Rejection envelope for an empty `dynamic_page` ui_show from a weak open model.
 * Authoring full HTML inline is the generation task these models fail at (an
 * empty `data: {}` here, or broken markup otherwise), so steering them to
 * "resend the HTML" just repeats the failure. Most widget requests are really
 * structured data — comparisons, results, metrics — which render reliably via a
 * field-based surface the model populates without writing any HTML, and which
 * cannot render blank. dynamic_page stays available for genuinely custom visual
 * HTML.
 */
const EMPTY_DYNAMIC_PAGE_DECLARATIVE_REDIRECT =
  'Error: ui_show dynamic_page was not displayed — `data.html` was empty, so the user would see a blank box. Authoring full HTML inline is error-prone; for data, comparisons, results, or metrics prefer a structured surface, which you fill with fields (no HTML) and which never renders blank. Re-show the content as one of: a `table` (ui_show { surface_type: "table", data: { columns: [{ id, label }], rows: [{ id, cells: { <columnId>: "<value>" } }] } }), a `card` ({ title, body, metadata: [{ label, value }] }), or `work_result` ({ summary, metrics: [{ label, value }] }). Only use dynamic_page when you genuinely need custom visual HTML, in which case include the complete markup in `data.html` now.';

/**
 * Worked ui_update example, appended to a successful task_progress `ui_show`
 * result so the model learns the update pattern at the point of use (with the
 * real surface_id in hand) rather than carrying it in the always-present tool
 * description.
 */
const TASK_PROGRESS_UPDATE_HINT =
  'As each step finishes, call ui_update with this surface_id to advance it — e.g. ui_update { surface_id: "<the surface_id above>", data: { templateData: { steps: [{ label: "Scaffold project", status: "completed" }, { label: "Wire up commands", status: "in_progress" }] } } }';

function isTaskProgressCardShow(input: Record<string, unknown>): boolean {
  if (input.template === "task_progress") {
    return true;
  }
  const data = asRecord(input.data);
  return data?.template === "task_progress";
}

/**
 * A `ui_update` whose `data` merge would change nothing: missing, not an
 * object, or containing only (recursively) empty objects. Merging such a
 * payload is a silent no-op — the surface keeps its prior state while the
 * client still reports "Surface updated" — so the model never learns its
 * update was hollow and a live card (e.g. task_progress) appears frozen.
 * Arrays (e.g. `templateData.steps`) and any non-empty primitive leaf count
 * as content.
 */
function isEmptyUpdate(input: Record<string, unknown>): boolean {
  const data = asRecord(input.data);
  return data === null || !hasContent(data);
}

function hasContent(value: unknown): boolean {
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

function isEmptyDynamicPage(input: Record<string, unknown>): boolean {
  if (input.surface_type !== "dynamic_page") {
    return false;
  }
  const data = asRecord(input.data);
  const html = data?.html;
  return typeof html !== "string" || html.trim().length === 0;
}

function isDynamicPageAppSubstitute(input: Record<string, unknown>): boolean {
  if (input.surface_type !== "dynamic_page") {
    return false;
  }

  const text = collectRoutingText(input).join(" ");
  if (
    APP_BUILDER_ARTIFACT_RE.test(text) &&
    (APP_BUILDER_BUILD_RE.test(text) || /\b(app|application)\b/i.test(text))
  ) {
    return true;
  }

  // Second signal: even when the model gives the surface a clean,
  // non-app-sounding title (dodging the text regex above), substantial
  // interactive HTML is an app being smuggled in as a transient surface.
  // A genuinely transient page is small and static; an app has real
  // scripted markup. Keep the bar high so simple snippets still pass.
  return isSubstantialInteractiveHtml(input);
}

const INTERACTIVE_HTML_RE =
  /<script\b|on[a-z]+\s*=|addEventListener|new Chart\b|window\.vellum\b/i;

function isSubstantialInteractiveHtml(input: Record<string, unknown>): boolean {
  const data = asRecord(input.data);
  const html = data?.html;
  if (typeof html !== "string") {
    return false;
  }
  return html.length > 2000 && INTERACTIVE_HTML_RE.test(html);
}

function collectRoutingText(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  addString(values, input.title);
  addString(values, input.activity);

  const data = asRecord(input.data);
  if (data) {
    const preview = asRecord(data.preview);
    if (preview) {
      addString(values, preview.title);
      addString(values, preview.subtitle);
      addString(values, preview.description);
    }
  }

  return values;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function addString(values: string[], value: unknown): void {
  if (typeof value === "string") {
    values.push(value);
  }
}

// ---------------------------------------------------------------------------
// ui_show
// ---------------------------------------------------------------------------

export const uiShowTool = {
  name: "ui_show",
  description:
    'Surface structured data or UI in the conversation. For long-form writing use the document skill. For interactive apps, dashboards, games, calculators, or durable tools, call `skill_load` with `skill: "app-builder"` and use the app-builder workflow; do not use `dynamic_page` as a substitute for a persistent app. App-like `dynamic_page` calls are rejected.\n\n' +
    "Surface types (data shapes):\n" +
    '- card: { title, subtitle?, body, metadata?: [{ label, value }], template?, templateData? }. Templates: "weather_forecast" (native weather widget), "task_progress" (live step tracker - update via ui_update on data.templateData; shape: { title, status: "in_progress"|"completed"|"failed", steps: [{ label, status: "pending"|"in_progress"|"completed"|"failed", detail? }] })\n' +
    "- copy_block: { text, label?, language? }. Shows copyable text with a visible copy button; use for prompts, commands, paths, or snippets the user should copy.\n" +
    '- choice: { description?, options: [{ id, title, description?, recommended?, data? }], selectionMode?: "single"|"multiple", commitOnSelect?, submitLabel? }. Single-select choices commit on option click by default. Use for outcome offers and follow-up choices; mark the strongest option with recommended: true.\n' +
    "- oauth_connect: { providerKey, displayName?, description?, logoUrl? }. Shows a managed OAuth connection CTA in chat; use when the current task needs a managed integration account (Google, Linear, GitHub, etc.) instead of asking the user to visit settings or attempting OAuth through shell/tools. The client supplies the CTA label. Do not include OAuth scopes in the surface; managed providers use the platform's configured scopes.\n" +
    '- table: { columns: [{ id, label }], rows: [{ id, cells: Record<id, string | { text, icon?, iconColor?: "success"|"warning"|"error"|"muted" }>, selectable?, selected? }], selectionMode?: "none"|"single"|"multiple", caption? }\n' +
    '- form: { description?, fields: [{ id, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label, placeholder?, required?, defaultValue?, options?: [{ label, value }] }], submitLabel? }. Multi-page: { pages: [{ id, title, description?, fields }], pageLabels?: { next?, back?, submit? }, submitLabel? }\n' +
    '- list: { items: [{ id, title, subtitle?, icon?, selected? }], selectionMode: "single"|"multiple"|"none" }\n' +
    "- confirmation: { message, detail?, confirmLabel?, confirmedLabel?, cancelLabel?, destructive? }\n" +
    "- dynamic_page: { html, width?, height?, preview?: { title, subtitle?, description?, icon?, metrics?: [{ label, value }] } }\n" +
    "- file_upload: { prompt, acceptedTypes?, maxFiles? }\n" +
    "- task_preferences: {} (no data needed — categories are rendered client-side)\n" +
    '- work_result: { eyebrow?, status?: "completed"|"partial"|"failed"|"in_progress", summary?, metrics?: [{ label, value, detail?, tone?: "neutral"|"positive"|"warning"|"negative" }], sections?: [{ id?, title, description?, type?: "items"|"timeline"|"diff"|"artifacts"|"warnings", items?: [{ id?, title, description?, status?, tone?, metadata?: [{ label, value }], href? }], diffs?: [{ label?, before?, after? }] }] }. Shows a structured receipt after real work: what changed, what was skipped, proof points, and next actions. Keep display-only unless explicit follow-up buttons are needed.\n' +
    '- channel_setup: { channel: "slack" | "telegram" | "phone" }. Opens the channel setup panel in a side drawer. Returns success only after a connected client confirms the panel rendered (an error means the user does NOT see the panel — never claim it is open after an error). The user then completes credential entry at their own pace. Slack shows a full setup wizard; Telegram and Phone show credential forms (the assistant handles remaining setup steps like webhooks in chat after the user saves credentials).\n\n' +
    "For multi-step or long-running turns (web searches, file operations, research), show a task_progress card early and keep its steps updated as work progresses. Coarse steps are fine, and you can add or revise them as the work takes shape — a rough card beats no signal.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_type: {
        type: "string",
        enum: [
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
          "task_preferences",
          "work_result",
        ],
        description: "The type of surface to display",
      },
      title: {
        type: "string",
        description: "Optional title for the surface window",
      },
      data: {
        type: "object",
        description:
          "Surface data; structure depends on surface_type (see tool description)",
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique action identifier" },
            label: { type: "string", description: "Button label text" },
            style: {
              type: "string",
              enum: ["primary", "secondary", "destructive"],
              description: "Visual style of the button",
            },
          },
          required: ["id", "label"],
        },
        description: "Optional action buttons to display on the surface",
      },
      display: {
        type: "string",
        enum: ["inline", "panel"],
        description:
          'Where to render the surface. "inline" embeds it in the chat message. "panel" shows a floating window. Defaults to "inline". Prefer inline — only use panel when a separate window is explicitly requested.',
      },
      await_action: {
        type: "boolean",
        description:
          "Whether to block until an action is selected. Defaults to true when actions are provided.",
      },
      persistent: {
        type: "boolean",
        description:
          "When true, clicking an action does not dismiss the surface — the card stays visible and only the clicked action is marked as spent. Use for launcher or menu-style cards where multiple buttons may be clicked. Defaults to false.",
      },
      activation_moment: {
        type: "string",
        enum: ACTIVATION_MOMENT_PARAMS,
        description:
          "Activation-rail telemetry tag (cohort only). Set this when this surface IS one of the activation funnel moments; the milestone is recorded automatically when the user commits the surface. Omit for all non-activation surfaces.",
      },
    },
    required: ["surface_type", "data"],
  },

  execute: proxyExecute("ui_show"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ui_update
// ---------------------------------------------------------------------------

export const uiUpdateTool = {
  name: "ui_update",
  description:
    "Update an existing surface's data. The provided data object is merged into the surface's current data.\n" +
    "For card templates (for example `task_progress`), update nested fields under `data.templateData` rather than sending template fields at the top level.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_id: {
        type: "string",
        description: "The ID of the surface to update",
      },
      data: {
        type: "object",
        description: "Partial data to merge into the existing surface data",
      },
    },
    required: ["surface_id", "data"],
  },

  execute: proxyExecute("ui_update"),
} satisfies ToolDefinition;

// ---------------------------------------------------------------------------
// ui_dismiss
// ---------------------------------------------------------------------------

const uiDismissTool = {
  name: "ui_dismiss",
  description: "Dismiss a currently displayed surface.",
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_id: {
        type: "string",
        description: "The ID of the surface to dismiss",
      },
    },
    required: ["surface_id"],
  },

  execute: proxyExecute("ui_dismiss"),
} satisfies ToolDefinition;

export const allUiSurfaceTools: ToolDefinition[] = [
  uiShowTool,
  uiUpdateTool,
  uiDismissTool,
];

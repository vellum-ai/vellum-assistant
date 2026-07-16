/**
 * UI surface tool definitions.
 *
 * These tools allow the model to show, update, and dismiss just-in-time UI
 * surfaces (cards, tables, forms, confirmations) on a connected macOS client.
 * They are proxy tools -- execution is forwarded to the client and never
 * handled locally by the daemon.
 */

import { RiskLevel } from "../../permissions/types.js";
import { isWeakOpenModel } from "../../providers/weak-open-model.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import {
  asRecord,
  hasContent,
  SURFACE_TYPE_NAMES,
  UI_SHOW_TYPE_DOCS,
  uiShowTeachingError,
} from "./surface-shape-docs.js";

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
    if (toolName === "ui_show") {
      const teachingError = uiShowTeachingError(input);
      if (teachingError !== null) {
        return { content: teachingError, isError: true };
      }
    }

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
    UI_SHOW_TYPE_DOCS,
  category: "ui-surface",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "host",

  input_schema: {
    type: "object",
    properties: {
      surface_type: {
        type: "string",
        enum: SURFACE_TYPE_NAMES,
        description: "The type of surface to display",
      },
      title: {
        type: "string",
        description: "Optional surface title",
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
            id: { type: "string" },
            label: { type: "string" },
            style: {
              type: "string",
              enum: ["primary", "secondary", "destructive"],
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
          'Where to render: "inline" (default, embedded in chat) or "panel" (floating window; only when explicitly requested)',
      },
      await_action: {
        type: "boolean",
        description:
          "Block until an action is selected. Defaults to true when actions are provided.",
      },
      persistent: {
        type: "boolean",
        description:
          "Keep the surface visible after an action is clicked (clicked actions are marked spent). For launcher/menu cards. Defaults to false.",
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

export const uiDismissTool = {
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

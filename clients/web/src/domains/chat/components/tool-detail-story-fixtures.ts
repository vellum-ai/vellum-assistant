/**
 * `ToolDetailPayload` fixtures for the tool-call detail catalogue (LUM-3509).
 *
 * Every fixture's `input` key set is a shape the tools genuinely send, so a
 * story cannot quietly review a payload the product never produces. Native
 * tools carry an `activity` sibling alongside `command` / `path`, so the same
 * sentence appears both as the panel's header and inside its raw input block.
 *
 * Values are written here rather than taken from any live conversation.
 *
 * Relative tool popularity is described qualitatively below, to rank the design
 * work. The measurements behind that ranking are internal and live on LUM-3509,
 * not in this repository.
 */

import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Defaults every fixture spreads, so a fixture states only the fields it is
 * actually exercising and a new required field lands in one place.
 */
const BASE = {
  activity: "",
  input: {},
  status: "completed",
} satisfies Partial<ToolDetailPayload>;

/**
 * Build a payload from `BASE`. The three identity fields are required rather
 * than defaulted: a placeholder tool name would let a fixture that forgot to
 * name its tool render as some other tool's story without failing anything.
 */
function payload(
  identity: Pick<ToolDetailPayload, "toolCallId" | "toolName" | "title"> &
    Partial<ToolDetailPayload>,
): ToolDetailPayload {
  return { ...BASE, ...identity };
}

// ---------------------------------------------------------------------------
// Native tools on the generic renderer
//
// These are the tools with no entry in `tool-activity-renderers`, so each one
// below renders as the title/activity/raw-JSON block plus a `<pre>` Output.
// Together they are the large majority of production tool calls.
// ---------------------------------------------------------------------------

/** `bash`, the single most-called tool in the product. */
export const bashDetail: ToolDetailPayload = payload({
  toolCallId: "tc-bash-1",
  toolName: "bash",
  title: "Working",
  activity: "Checking which files changed",
  input: {
    activity: "Checking which files changed",
    command: "git status --short && git diff --stat",
  },
  result: [
    " M clients/web/src/domains/chat/components/tool-detail-panel.tsx",
    "?? clients/web/src/domains/chat/components/tool-detail-story-fixtures.ts",
    "",
    " clients/web/src/domains/chat/components/tool-detail-panel.tsx | 12 ++++++----",
    " 1 file changed, 8 insertions(+), 4 deletions(-)",
  ].join("\n"),
  riskLevel: "medium",
  durationLabel: "1.2s",
});

/**
 * `bash` mid-flight with a streaming stdout tail. The panel shows
 * `streamedOutput` under Output until the final `result` lands.
 */
export const bashStreamingDetail: ToolDetailPayload = payload({
  toolCallId: "tc-bash-2",
  toolName: "bash",
  title: "Working",
  activity: "Running the web test suite",
  input: {
    activity: "Running the web test suite",
    command: "bun test src/domains/chat",
    timeout_seconds: 600,
  },
  result: undefined,
  streamedOutput: [
    "bun test v1.1.30",
    "",
    "src/domains/chat/components/risk-badge.test.tsx:",
    "(pass) RiskBadge > renders the low tolerance hint [2.10ms]",
    "(pass) RiskBadge > renders the high tolerance hint [0.94ms]",
    "",
    "src/domains/chat/components/tool-detail-panel.test.tsx:",
    "(pass) ToolDetailPanel > shows the risk notice [3.42ms]",
  ].join("\n"),
  status: "running",
  riskLevel: "medium",
});

/** A `bash` call the user declined at the confirmation prompt. */
export const bashDeniedDetail: ToolDetailPayload = payload({
  toolCallId: "tc-bash-3",
  toolName: "bash",
  title: "Working",
  activity: "Removing the build output",
  input: {
    activity: "Removing the build output",
    command: "rm -rf dist",
    timeout_seconds: 120,
  },
  result: undefined,
  status: "denied",
  riskLevel: "high",
});

/** A `bash` call whose command failed. */
export const bashErrorDetail: ToolDetailPayload = payload({
  toolCallId: "tc-bash-4",
  toolName: "bash",
  title: "Working",
  activity: "Type-checking the web client",
  input: {
    activity: "Type-checking the web client",
    command: "bunx tsc --noEmit",
    timeout_seconds: 300,
  },
  result: [
    "src/domains/chat/components/tool-detail-panel.tsx(184,9): error TS2322:",
    "  Type 'string | undefined' is not assignable to type 'string'.",
    "    Type 'undefined' is not assignable to type 'string'.",
    'error: script "tsc" exited with code 2',
  ].join("\n"),
  status: "error",
  riskLevel: "low",
});

/** `file_read`, the second most-called tool. */
export const fileReadDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-read-1",
  toolName: "file_read",
  title: "Reading a file",
  activity: "Reading the risk helpers",
  input: {
    activity: "Reading the risk helpers",
    path: "clients/web/src/domains/chat/utils/risk.ts",
  },
  result: [
    'import type { NoticeTone } from "@vellumai/design-library";',
    "",
    "const VALID_RISK_LEVELS: ReadonlySet<string> = new Set([",
    '  "low",',
    '  "medium",',
    '  "high",',
    "]);",
  ].join("\n"),
  riskLevel: "low",
  durationLabel: "0.1s",
});

/** `file_read` against a path that does not exist. */
export const fileReadMissingDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-read-2",
  toolName: "file_read",
  title: "Reading a file",
  activity: "Reading the changelog",
  input: {
    activity: "Reading the changelog",
    path: "clients/web/CHANGELOG.md",
  },
  result:
    "Error: ENOENT: no such file or directory, open 'clients/web/CHANGELOG.md'",
  status: "error",
  riskLevel: "low",
});

/**
 * `file_read` that returned nothing. Reading an empty file is routine, and the
 * panel reports it rather than leaving the Output section out.
 */
export const fileReadEmptyDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-read-3",
  toolName: "file_read",
  title: "Reading a file",
  activity: "Reading the local env file",
  input: {
    activity: "Reading the local env file",
    path: "clients/web/.env.local",
    max_chars: 20000,
  },
  result: "",
  riskLevel: "low",
});

/** `file_write`. The written body rides in the input, not the output. */
export const fileWriteDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-write-1",
  toolName: "file_write",
  title: "Writing a file",
  activity: "Adding the fixture module",
  input: {
    activity: "Adding the fixture module",
    path: "clients/web/src/domains/chat/components/tool-detail-story-fixtures.ts",
    content: [
      'import type { ToolDetailPayload } from "@/stores/viewer-store";',
      "",
      "export const bashDetail: ToolDetailPayload = {",
      '  toolCallId: "tc-bash-1",',
      '  toolName: "bash",',
      '  input: { activity: "Checking status", command: "git status" },',
      '  status: "completed",',
      "};",
    ].join("\n"),
  },
  result:
    "Wrote 7 lines to clients/web/src/domains/chat/components/tool-detail-story-fixtures.ts",
  riskLevel: "medium",
  durationLabel: "0.3s",
});

/**
 * `file_edit`. Its `old_string` / `new_string` pair is a diff
 * the panel currently renders as two JSON string literals with escaped
 * newlines, which is the clearest case for a native treatment.
 */
export const fileEditDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-edit-1",
  toolName: "file_edit",
  title: "Editing a file",
  activity: "Widening the risk level union",
  input: {
    activity: "Widening the risk level union",
    path: "clients/web/src/domains/chat/utils/risk.ts",
    old_string:
      'const VALID_RISK_LEVELS: ReadonlySet<string> = new Set([\n  "low",\n  "medium",\n]);',
    new_string:
      'const VALID_RISK_LEVELS: ReadonlySet<string> = new Set([\n  "low",\n  "medium",\n  "high",\n]);',
  },
  result: "Applied 1 edit to clients/web/src/domains/chat/utils/risk.ts",
  riskLevel: "medium",
});

/** `remember`, whose result is a short acknowledgement. */
export const rememberDetail: ToolDetailPayload = payload({
  toolCallId: "tc-remember-1",
  toolName: "remember",
  title: "Remembering",
  activity: "Saving a preference",
  input: {
    activity: "Saving a preference",
    content:
      "Prefers the standup summary grouped by project rather than by day.",
  },
  result: "Saved to memory.",
  riskLevel: "low",
});

/** `recall`, which sends the highest-arity native input. */
export const recallDetail: ToolDetailPayload = payload({
  toolCallId: "tc-recall-1",
  toolName: "recall",
  title: "Recalling",
  activity: "Looking up the release checklist",
  input: {
    activity: "Looking up the release checklist",
    query: "release checklist staging bake",
    depth: "deep",
    max_results: 10,
    sources: ["memory", "conversations", "documents"],
  },
  result: [
    "1. Release checklist (memory, updated 3 days ago)",
    "   Cut the release branch, let staging bake, then dispatch production.",
    "2. Staging bake window (conversation, 1 week ago)",
    "   The bake is 30 minutes unless the diff touches the gateway.",
  ].join("\n"),
  riskLevel: "low",
});

/** `code_search`, the widest native input shape. */
export const codeSearchDetail: ToolDetailPayload = payload({
  toolCallId: "tc-code-search-1",
  toolName: "code_search",
  title: "Searching",
  activity: "Finding the renderer registry",
  input: {
    activity: "Finding the renderer registry",
    pattern: "getToolActivityRenderer",
    path: "clients/web/src",
    glob: "*.{ts,tsx}",
    max_results: 20,
    context_lines: 2,
    case_insensitive: false,
  },
  result: [
    "clients/web/src/domains/chat/components/tool-activity/tool-activity-renderers.ts:26",
    "export function getToolActivityRenderer(",
    "",
    "clients/web/src/domains/chat/components/tool-detail-panel.tsx:33",
    'import { getToolActivityRenderer } from "@/domains/chat/components/tool-activity/tool-activity-renderers";',
  ].join("\n"),
  riskLevel: "low",
});

/**
 * `subagent_spawn`. Note the absence of an `activity` key: it is the one native
 * tool that almost never sends one, so the panel falls back to its `title` for
 * the header where the file and shell tools show a sentence.
 */
export const subagentSpawnDetail: ToolDetailPayload = payload({
  toolCallId: "tc-subagent-1",
  toolName: "subagent_spawn",
  title: "Spawning subagent",
  activity: "",
  input: {
    label: "renderer-audit",
    objective:
      "List every tool name that reaches the detail panel without a purpose-built renderer, and rank them by how often they run.",
    role: "researcher",
    send_result_to_user: false,
  },
  result: JSON.stringify(
    {
      summary:
        "Five tool families cover the majority of calls: shell, file read, file write, file edit, and memory.",
      ranked: ["bash", "file_read", "remember", "file_write", "file_edit"],
    },
    null,
    2,
  ),
  riskLevel: "low",
  durationLabel: "44s",
});

// ---------------------------------------------------------------------------
// Managed workspace and MCP tools
// ---------------------------------------------------------------------------

/**
 * A managed workspace tool (`scaffold_managed_skill`). Nothing
 * distinguishes it from a native tool in the panel; it is here because its
 * nested-object input is the shape that reads worst as raw JSON.
 */
export const managedWorkspaceDetail: ToolDetailPayload = payload({
  toolCallId: "tc-managed-1",
  toolName: "scaffold_managed_skill",
  title: "Building a skill",
  activity: "Scaffolding the standup skill",
  input: {
    activity: "Scaffolding the standup skill",
    name: "standup",
    description: "Generate a standup update from recent commits and tickets.",
    metadata: {
      triggers: ["standup", "daily update"],
      surfaces: ["chat", "schedule"],
      inputs: { since: "24h", grouping: "project" },
    },
  },
  result: "Created skill 'standup' with 3 files under skills/standup/.",
  riskLevel: "medium",
});

/**
 * An MCP tool. The panel titles this by running the raw wire name through
 * `titleCaseToolName`, so `mcp__analytics__exec` reads as "Mcp Analytics Exec":
 * the server and the tool are not separated, and the `mcp` prefix is shown to
 * the user as though it were a word.
 */
export const mcpDetail: ToolDetailPayload = payload({
  toolCallId: "tc-mcp-1",
  toolName: "mcp__analytics__exec",
  title: "Working",
  activity: "Querying weekly active users",
  input: {
    activity: "Querying weekly active users",
    query:
      "SELECT toStartOfWeek(timestamp) AS week, count(DISTINCT person_id) AS users FROM events WHERE timestamp > now() - INTERVAL 28 DAY GROUP BY week ORDER BY week",
  },
  result: JSON.stringify(
    {
      columns: ["week", "users"],
      rows: [
        ["2026-08-03", 12840],
        ["2026-08-10", 13217],
        ["2026-08-17", 13655],
        ["2026-08-24", 14102],
      ],
    },
    null,
    2,
  ),
  riskLevel: "medium",
});

/** A second MCP server, to show the naming problem is not specific to one server. */
export const mcpSqlDetail: ToolDetailPayload = payload({
  toolCallId: "tc-mcp-2",
  toolName: "mcp__warehouse__execute_sql",
  title: "Working",
  activity: "Counting rows in the accounts table",
  input: {
    activity: "Counting rows in the accounts table",
    query: "select count(*) from public.accounts where deleted_at is null",
  },
  result: "count\n-----\n  8213\n(1 row)",
  riskLevel: "high",
});

/**
 * An unrecognised third-party tool: the generic fallback with nothing special
 * about it. Stands in for every integration we cannot enumerate, which is the
 * point of having it in the catalogue rather than one story per vendor.
 */
export const unknownToolDetail: ToolDetailPayload = payload({
  toolCallId: "tc-unknown-1",
  toolName: "acme_crm_upsert_contact",
  title: "Working",
  activity: "",
  input: {
    record: {
      email: "user@example.com",
      stage: "qualified",
      owner: { team: "growth", region: "emea" },
      tags: ["inbound", "trial"],
    },
    upsert: true,
  },
  result: JSON.stringify(
    { id: "cnt_8842", created: false, updated: true },
    null,
    2,
  ),
});

// ---------------------------------------------------------------------------
// Content-shape edges
// ---------------------------------------------------------------------------

/**
 * Long enough to exercise the Output clamp. The daemon truncates a tool result
 * at up to `HARD_MAX_TOOL_RESULT_CHARS` (400,000, see
 * `assistant/src/plugins/defaults/tool-result-truncate/`), so this is well
 * inside what the panel can be handed. Generated rather than embedded so the
 * fixture file stays readable.
 */
export const largeOutputDetail: ToolDetailPayload = payload({
  toolCallId: "tc-bash-large",
  toolName: "bash",
  title: "Working",
  activity: "Listing the dependency tree",
  input: {
    activity: "Listing the dependency tree",
    command: "bun pm ls --all",
  },
  result: Array.from({ length: 400 }, (_, i) => {
    const name = `@vellumai/package-${String(i).padStart(3, "0")}`;
    return `├── ${name}@1.${i % 20}.${i % 7} resolved to node_modules/${name}`;
  }).join("\n"),
  riskLevel: "low",
});

/**
 * A single-line input and a single-line output. The smallest thing the panel
 * ever shows, and the case where its section chrome is heaviest relative to
 * the content it frames.
 */
export const minimalDetail: ToolDetailPayload = payload({
  toolCallId: "tc-file-list-1",
  toolName: "file_list",
  title: "Listing files",
  activity: "Listing the components folder",
  input: { activity: "Listing the components folder", path: "clients/web/src" },
  result: "assistant/\ncomponents/\ndomains/\ni18n/\nlib/\nstores/\nutils/",
});

// ---------------------------------------------------------------------------
// Risk levels
//
// `getRiskNoticeTone` and `getRiskBadgeWeakStyle` recognise low, medium, high
// and workspace, and fall through to a neutral "Unknown" for anything else.
// ---------------------------------------------------------------------------

/** A `bashDetail` at one risk level, keyed so each level is its own call. */
export function riskVariant(riskLevel: string | undefined): ToolDetailPayload {
  return {
    ...bashDetail,
    toolCallId: `tc-risk-${riskLevel ?? "absent"}`,
    riskLevel,
  };
}

// ---------------------------------------------------------------------------
// Skills, which are the only tools with purpose-built renderers today
// ---------------------------------------------------------------------------

/**
 * A `skill_load` body shaped like the daemon's real output: instruction
 * markdown followed by the machine-facing "## Available Tools" manifest that
 * `formatToolSchemas` emits, and the `<loaded_skill />` trailer.
 */
const skillLoadResult = [
  "Skill: App Builder",
  "ID: app-builder",
  "Description: Build persistent apps in the user's Library.",
  "Path: /skills/app-builder/SKILL.md",
  "",
  "# App Builder",
  "",
  "Build **persistent apps** in the user's Library, such as dashboards,",
  "trackers, calculators, and games that survive across conversations.",
  "",
  "## Workflow",
  "",
  "1. Call `app_create` with a display name.",
  "2. Write the app source into the returned folder.",
  "3. Call `app_refresh` to rebuild and preview.",
  "",
  "## Available Tools",
  "",
  "Use `skill_execute` to call these tools.",
  "",
  "### app_create",
  "Create a new app in the user's Library and return its folder path.",
  "Parameters:",
  "- name (string, required): Display name shown in the Library.",
  "- template (string, optional): Starter template id.",
  "",
  "### app_refresh",
  "Rebuild an existing app and refresh any open preview.",
  "Parameters:",
  "- app_id (string, required): Id returned by app_create.",
  "",
  // Machine-only trailer the daemon appends. Must not leak into the last
  // tool's description or the rendered instructions.
  "Included Skills (immediate): none",
  "",
  '<loaded_skill id="app-builder" version="abc123" />',
].join("\n");

/** `skill_load`, the more-used of the two skill tools. */
export const skillLoadDetail: ToolDetailPayload = payload({
  toolCallId: "tc-skill-load-1",
  toolName: "skill_load",
  title: "Using a skill",
  activity: "Loading the app-builder skill",
  input: { skill: "app-builder" },
  result: skillLoadResult,
  riskLevel: "low",
});

/**
 * A skill body past the Output clamp threshold, so the story shows the
 * "Show more" control in the default Clean view rather than only in Raw.
 */
export const skillLoadLongDetail: ToolDetailPayload = {
  ...skillLoadDetail,
  toolCallId: "tc-skill-load-long",
  result: skillLoadResult.replace(
    "## Workflow",
    [
      "## When to use this",
      "",
      "Reach for the app builder when the user asks for something that",
      "should outlive the conversation: a tracker they will come back to, a",
      "dashboard over their own data, a small tool they would otherwise",
      "rebuild by hand each time. A one-off calculation or a chart they only",
      "need once is not an app; answer it inline instead.",
      "",
      "If the request is really a report, write the report. An app earns its",
      "place when the user will return to it with new data, change what it",
      "shows, or share it with someone else. Those three are the signal; a",
      "single answer, however elaborate, is not.",
      "",
      "## Naming",
      "",
      "Name the app for what the user calls the thing, not for the mechanism.",
      "A person tracking their runs wants a Run log, not a Time Series",
      "Dashboard. The name is the first thing they see in the Library and the",
      "last thing they remember about it.",
      "",
      "## Workflow",
    ].join("\n"),
  ),
};

/** `skill_load` still in flight, before the instruction body lands. */
export const skillLoadRunningDetail: ToolDetailPayload = {
  ...skillLoadDetail,
  toolCallId: "tc-skill-load-running",
  result: undefined,
  status: "running",
};

/** A failed `skill_load`, whose error should read as prose. */
export const skillLoadErrorDetail: ToolDetailPayload = payload({
  toolCallId: "tc-skill-load-2",
  toolName: "skill_load",
  title: "Using a skill",
  activity: "Loading the meet-join skill",
  input: { skill: "meet-join" },
  result:
    "Error: skill 'meet-join' is currently unavailable. This skill is feature-gated and not enabled for this workspace.",
  status: "error",
});

/**
 * `skill_execute`, which is very rarely called. Its renderer unwraps the
 * `{ tool, input, activity }` envelope so the inner tool leads.
 */
export const skillExecuteDetail: ToolDetailPayload = payload({
  toolCallId: "tc-skill-exec-1",
  toolName: "skill_execute",
  title: "Using a skill",
  activity: "Creating your budget tracker app",
  input: {
    activity: "Creating your budget tracker app",
    tool: "app_create",
    input: {
      name: "Budget tracker",
      template: "dashboard",
      public: false,
      config: { currency: "USD", categories: ["rent", "food", "transit"] },
    },
  },
  result: "Created app 'Budget tracker' at ~/Library/apps/budget-tracker",
  riskLevel: "low",
});

// ---------------------------------------------------------------------------
// Non-tool variants of the same panel
// ---------------------------------------------------------------------------

/** The `thinking` variant, which renders reasoning markdown and no I/O sections. */
export const thinkingDetail: ToolDetailPayload = payload({
  toolCallId: "",
  toolName: "",
  title: "Thinking",
  kind: "thinking",
  thinkingText: [
    "The user wants the tool detail panel inventoried before we redesign it.",
    "",
    "First I should find every renderer family that exists today, then decide",
    "which states are worth a story. Two things matter:",
    "",
    "- Which tools actually **run** in production, not which ones look interesting.",
    "- Which states the panel can reach that nothing currently reviews.",
    "",
    "Given that, the plan is to let real usage rank the work rather than taste.",
  ].join("\n"),
});

/**
 * `web_fetch`. Its result carries a small header (requested and final URL,
 * status, any notices) above a `Content:` marker, which the fetch view parses
 * into a page-shaped summary instead of showing the envelope.
 */
export const webFetchDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-1",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the autodocs page",
  input: {
    activity: "Reading the autodocs page",
    url: "https://storybook.js.org/docs/writing-docs/autodocs",
    max_chars: 20000,
  },
  result: [
    "Requested URL: https://storybook.js.org/docs/writing-docs/autodocs",
    "Final URL: https://storybook.js.org/docs/writing-docs/autodocs",
    "Status: 200",
    "Content:",
    "# Autodocs",
    "",
    "Storybook can automatically generate a documentation page from a set of",
    "stories by adding the `autodocs` tag to a component's meta.",
  ].join("\n"),
  riskLevel: "low",
});

/**
 * A search that failed. There are no sources to lay out, so it deliberately
 * falls through to the generic body, where the error renders in full the way
 * any other failed tool's does.
 */
export const webSearchErrorDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-search-2",
  toolName: "web_search",
  title: "Searching the web",
  activity: "Searching for Storybook autodocs configuration",
  kind: "web_search",
  input: { activity: "Searching the web", query: "storybook autodocs tag" },
  searchQuery: "storybook autodocs tag",
  searchResults: [],
  result:
    "Error: the search provider returned 503 Service Unavailable after 3 attempts.",
  status: "error",
});

/**
 * The `web_search` variant: the query and the sources it found, in place of the
 * input and output blocks.
 */
export const webSearchDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-search-1",
  toolName: "web_search",
  title: "Searching the web",
  activity: "Searching for Storybook autodocs configuration",
  kind: "web_search",
  input: { activity: "Searching the web", query: "storybook autodocs tag" },
  searchQuery: "storybook autodocs tag",
  searchResults: [
    {
      rank: 1,
      title: "Autodocs | Storybook docs",
      url: "https://storybook.js.org/docs/writing-docs/autodocs",
      domain: "storybook.js.org",
    },
    {
      rank: 2,
      title: "Documentation addon",
      url: "https://storybook.js.org/addons/@storybook/addon-docs",
      domain: "storybook.js.org",
    },
  ],
});

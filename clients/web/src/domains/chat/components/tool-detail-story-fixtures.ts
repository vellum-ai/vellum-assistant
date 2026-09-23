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
// Native tools
//
// The large majority of production tool calls. `bash`, the file-change tools,
// `remember` and `recall` have their own renderers in
// `tool-activity-renderers`; the rest render as the generic parameters block
// plus a `<pre>` Output.
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
  activity: "Saving standup preferences",
  input: {
    activity: "Saving standup preferences",
    content: [
      "Prefers the standup summary grouped by project rather than by day.",
      "Wants blockers listed before progress in every summary.",
    ],
  },
  result: "Saved 2 facts to knowledge base.",
  activityMetadata: {
    remember: {
      facts: [
        "Prefers the standup summary grouped by project rather than by day.",
        "Wants blockers listed before progress in every summary.",
      ],
    },
  },
  riskLevel: "low",
});

const recallInput = {
  activity: "Looking up the release checklist",
  query: "release checklist staging bake",
  depth: "deep",
  max_results: 10,
  sources: ["memory", "conversations", "workspace"],
};

/** `recall`, which sends the highest-arity native input. */
export const recallDetail: ToolDetailPayload = payload({
  toolCallId: "tc-recall-1",
  toolName: "recall",
  title: "Recalling",
  activity: "Looking up the release checklist",
  input: recallInput,
  result: [
    "Cut the release branch, let staging bake for 30 minutes, then dispatch production. The bake runs longer when the diff touches the gateway.",
    "",
    "Searched sources: memory, conversations, workspace.",
  ].join("\n"),
  activityMetadata: {
    recall: {
      query: "release checklist staging bake",
      depth: "deep",
      sources: ["memory", "conversations", "workspace"],
      answer:
        "Cut the release branch, let staging bake for **30 minutes**, then dispatch production. The bake runs longer when the diff touches the gateway.",
      evidence: [
        {
          source: "memory",
          title: "release-checklist",
          locator: "memory/concepts/release-checklist.md:3",
          path: "memory/concepts/release-checklist.md",
          excerpt:
            "3: Cut the release branch, let staging bake, then dispatch production.",
        },
        {
          source: "conversations",
          title: "Planning the Thursday release",
          locator:
            "5b1e9c2a-7f40-4d8e-9a11-3c6f2e8d0b47#c02f4a91-1e6b-4b7d-8c35-9d2e7a6f1b08",
          excerpt:
            "The bake is 30 minutes unless the diff touches the gateway, then an hour.",
          timestampMs: 1_757_000_000_000,
          conversationId: "5b1e9c2a-7f40-4d8e-9a11-3c6f2e8d0b47",
          messageId: "c02f4a91-1e6b-4b7d-8c35-9d2e7a6f1b08",
        },
        {
          source: "workspace",
          title: "docs/releasing.md",
          locator: "docs/releasing.md:14",
          path: "docs/releasing.md",
          excerpt:
            "14: Wait for the staging bake before dispatching production.",
        },
      ],
      searchedSources: [
        { source: "memory", status: "searched", evidenceCount: 4 },
        { source: "conversations", status: "searched", evidenceCount: 2 },
        { source: "workspace", status: "searched", evidenceCount: 1 },
      ],
    },
  },
  riskLevel: "low",
});

/**
 * `recall` from history recorded before it reported a structured result: the
 * text is all there is.
 */
export const recallTextOnlyDetail: ToolDetailPayload = payload({
  toolCallId: "tc-recall-2",
  toolName: "recall",
  title: "Recalling",
  activity: "Looking up the release checklist",
  input: recallInput,
  result: [
    "Found evidence:",
    "1. [memory] Release checklist (memory/release-checklist.md): Cut the release branch, let staging bake, then dispatch production.",
    "2. [conversations] Staging bake window (Planning the Thursday release, 1 week ago): The bake is 30 minutes unless the diff touches the gateway, then an hour.",
    "Searched sources: memory, conversations, workspace.",
  ].join("\n"),
  riskLevel: "low",
});

/** `recall` that found nothing, with one place it could not fully search. */
export const recallNothingFoundDetail: ToolDetailPayload = payload({
  toolCallId: "tc-recall-3",
  toolName: "recall",
  title: "Recalling",
  activity: "Looking for the offsite venue",
  input: { activity: "Looking for the offsite venue", query: "offsite venue" },
  result: [
    "No reliable results found.",
    "Searched sources: memory, conversations, workspace.",
    "Degraded sources: workspace (search index is still building).",
  ].join("\n"),
  activityMetadata: {
    recall: {
      query: "offsite venue",
      depth: "standard",
      sources: ["memory", "conversations", "workspace"],
      evidence: [],
      searchedSources: [
        { source: "memory", status: "searched", evidenceCount: 0 },
        { source: "conversations", status: "searched", evidenceCount: 0 },
        {
          source: "workspace",
          status: "degraded",
          evidenceCount: 0,
          error: "search index is still building",
        },
      ],
    },
  },
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
 * A third-party tool whose input carries a list of records. The list lays out
 * as a table with a column per key across the records; the second contact has
 * no `owner`, so that cell is empty rather than breaking the table.
 */
export const recordListDetail: ToolDetailPayload = payload({
  toolCallId: "tc-contacts-import-1",
  toolName: "acme_crm_import_contacts",
  title: "Working",
  activity: "Importing three contacts into the inbound list",
  input: {
    activity: "Importing three contacts into the inbound list",
    list: "Inbound",
    contacts: [
      { email: "ada@example.com", stage: "qualified", owner: "growth" },
      { email: "grace@example.com", stage: "new" },
      { email: "linus@example.com", stage: "trial", owner: "sales" },
    ],
    skip_existing: true,
  },
  result: JSON.stringify({ imported: 3, skipped: 0 }, null, 2),
  riskLevel: "medium",
});

/**
 * A third-party tool whose parameters show both halves of the text rule: a
 * long note on one line reads inline and folds behind Show more, and a short
 * checklist with line breaks keeps its lines in a block.
 */
export const longTextParameterDetail: ToolDetailPayload = payload({
  toolCallId: "tc-notes-append-1",
  toolName: "acme_notes_append",
  title: "Working",
  activity: "Adding the planting plan to the garden notebook",
  input: {
    activity: "Adding the planting plan to the garden notebook",
    notebook: "Garden",
    note: [
      "Start tomatoes, peppers and basil indoors in the second week of March under the shop light, and keep the tray on the heat mat until most seedlings are up.",
      "Harden them off on the porch for ten days once nights stay above ten degrees, bringing them in if the forecast drops.",
      "Plant the tomatoes in the two back beds with cages set at planting time, peppers along the fence where they get afternoon sun, and basil between the tomatoes.",
      "Direct sow beans and squash in the front bed after the last frost date, then mulch everything with straw once the soil has warmed.",
      "Water deeply twice a week rather than a little every day, and check the drip line for clogs at the start of each month.",
      "Pick beans every other day once they start, and pull any squash leaves that show mildew before it spreads down the row.",
    ].join(" "),
    checklist: "Order compost\nFix the rain barrel tap\nLabel the seed trays",
  },
  result: JSON.stringify({ appended: true }, null, 2),
  riskLevel: "low",
});

/**
 * A query whose result is a list of thirty records with ten keys each: wider
 * than the drawer and taller than a screen. The columns take the width of
 * their values on one line and the table scrolls sideways; the long `website`
 * column wraps once it reaches the width cap.
 */
export const wideTableOutputDetail: ToolDetailPayload = payload({
  toolCallId: "tc-accounts-query-1",
  toolName: "mcp__warehouse__query",
  title: "Working",
  activity: "Listing the accounts on the team and enterprise plans",
  input: {
    activity: "Listing the accounts on the team and enterprise plans",
    query:
      "select * from accounts where plan in ('team', 'enterprise') limit 30",
  },
  result: JSON.stringify(
    Array.from({ length: 30 }, (_, index) => ({
      id: `acct_${1000 + index}`,
      name: `Example Account ${index + 1}`,
      email: `user${index + 1}@example.com`,
      plan: index % 3 === 0 ? "enterprise" : "team",
      seats: 10 + index,
      region: "us-east-1",
      created_at: "2026-08-03T12:00:00Z",
      owner: "growth",
      status: index % 4 === 0 ? "churn_risk" : "active",
      website: `https://example.com/accounts/${1000 + index}/overview`,
    })),
  ),
  riskLevel: "low",
});

/**
 * Output of many short lines: forty file paths, far under the length that
 * reads as "long" in characters but taller than the fold, so it folds by the
 * height it is drawn at.
 */
export const manyShortLinesDetail: ToolDetailPayload = payload({
  toolCallId: "tc-list-files-1",
  toolName: "acme_repo_list_files",
  title: "Working",
  activity: "Listing the files the change touched",
  input: {
    activity: "Listing the files the change touched",
    since: "main",
  },
  result: Array.from({ length: 40 }, (_, index) => `src/f${index + 1}.ts`).join(
    "\n",
  ),
  riskLevel: "low",
});

/**
 * A parameter that is a list of twenty records: a table taller than the fold,
 * so the table folds as one value with a single Show more.
 */
export const tallTableParameterDetail: ToolDetailPayload = payload({
  toolCallId: "tc-tasks-import-1",
  toolName: "acme_tasks_import",
  title: "Working",
  activity: "Importing twenty tasks into the launch board",
  input: {
    activity: "Importing twenty tasks into the launch board",
    board: "Launch",
    tasks: Array.from({ length: 20 }, (_, index) => ({
      title: `Task ${index + 1}`,
      owner: index % 2 === 0 ? "design" : "engineering",
      due: `2026-10-${String(index + 1).padStart(2, "0")}`,
    })),
  },
  result: JSON.stringify({ imported: 20 }),
  riskLevel: "low",
});

/**
 * A parameter that is an object of many fields: a nested group taller than the
 * fold, so the group folds as one value.
 */
export const tallNestedParameterDetail: ToolDetailPayload = payload({
  toolCallId: "tc-settings-update-1",
  toolName: "acme_workspace_update_settings",
  title: "Working",
  activity: "Updating the workspace notification settings",
  input: {
    activity: "Updating the workspace notification settings",
    settings: {
      digest: "daily",
      digest_hour: 9,
      timezone: "America/New_York",
      mentions: "immediately",
      replies: "immediately",
      reactions: "never",
      weekly_summary: true,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      channels: "email and push",
      escalate_after_minutes: 30,
      include_resolved: false,
    },
  },
  result: JSON.stringify({ updated: true }),
  riskLevel: "low",
});

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
// `getRiskBadgeWeakStyle` recognises low, medium, high and workspace, and falls
// through to a neutral "Unknown" for anything else. Only the first three have a
// tolerance sentence, so the rest render as a bare pill.
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
// Skills
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
/**
 * A skill advertising many tools, each with a full description. The list is
 * what runs the panel on, so it folds as one value rather than per row.
 */
export const skillLoadManyToolsDetail: ToolDetailPayload = {
  ...skillLoadDetail,
  toolCallId: "tc-skill-load-many-tools",
  result: skillLoadResult.replace(
    [
      "### app_refresh",
      "Rebuild an existing app and refresh any open preview.",
      "Parameters:",
      "- app_id (string, required): Id returned by app_create.",
    ].join("\n"),
    [
      "### app_refresh",
      "Rebuild an existing app and refresh any open preview. Use it after",
      "writing source into the app's folder; the preview reloads in place.",
      "Parameters:",
      "- app_id (string, required): Id returned by app_create.",
      "",
      "### app_list",
      "List the apps in the user's Library, most recently updated first, with",
      "each app's id, name, description and timestamps.",
      "",
      "### app_open",
      "Open an app for the user. Pass the id returned by app_create, or a",
      "name to resolve first with app_list.",
      "",
      "### app_rename",
      "Rename an app in the Library. The folder keeps its id, so links and",
      "open previews survive the rename.",
      "",
      "### app_delete",
      "Remove an app from the Library. The folder is kept for a grace period",
      "so an accidental delete can be undone from the Library.",
      "",
      "### app_share",
      "Publish an app to a link the user can send on. The link stays private",
      "until they share it, and revoking it takes the app offline.",
    ].join("\n"),
  ),
};

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
const AUTODOCS_URL = "https://storybook.js.org/docs/writing-docs/autodocs";

const AUTODOCS_PAGE = [
  "# Autodocs",
  "",
  "Storybook can automatically generate a documentation page from a set of",
  "stories by adding the `autodocs` tag to a component's meta.",
];

/** `web_fetch` as the daemon records it now: the page plus its metadata. */
export const webFetchDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-1",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the autodocs page",
  input: {
    activity: "Reading the autodocs page",
    url: AUTODOCS_URL,
    max_chars: 20000,
  },
  result: [
    `Requested URL: ${AUTODOCS_URL}`,
    `Final URL: ${AUTODOCS_URL}`,
    "Status: 200 OK",
    "Content-Type: text/html; charset=utf-8",
    "Content:",
    ...AUTODOCS_PAGE,
  ].join("\n"),
  activityMetadata: {
    webFetch: {
      url: AUTODOCS_URL,
      finalUrl: AUTODOCS_URL,
      provider: "default",
      status: 200,
      contentType: "text/html; charset=utf-8",
      byteCount: 48210,
      charCount: 214,
      truncated: false,
      title: "Autodocs | Storybook docs",
      domain: "storybook.js.org",
      redirectCount: 0,
      durationMs: 640,
      startIndexPastEnd: false,
    },
  },
  riskLevel: "low",
});

/** A fetched page long enough to run the panel on, so it folds. */
export const webFetchLongPageDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-6",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the autodocs page",
  input: { activity: "Reading the autodocs page", url: AUTODOCS_URL },
  result: [
    `Requested URL: ${AUTODOCS_URL}`,
    `Final URL: ${AUTODOCS_URL}`,
    "Status: 200 OK",
    "Content:",
    "# Autodocs",
    "",
    "Storybook can generate a documentation page from a set of stories by",
    "adding the `autodocs` tag to a component's meta.",
    "",
    "## Setting it up",
    "",
    "Tag the meta and every story inherits the page. A story can opt out with",
    "the `!autodocs` tag, which is the escape hatch for a case the generated",
    "page reads badly for.",
    "",
    "## What lands on the page",
    "",
    "The component's props table, each story rendered with its source, and",
    "whatever the component's own docs block adds. The order follows the file.",
    "",
    "## Writing the description",
    "",
    "The description comes from the component's docstring, so it is written",
    "once and read in two places: the editor and the docs page.",
    "",
    "## Customising",
    "",
    "A docs page is itself a story, so it takes parameters like any other, and",
    "a project can replace the template wholesale where the default does not",
    "suit the component.",
  ].join("\n"),
  activityMetadata: {
    webFetch: {
      url: AUTODOCS_URL,
      finalUrl: AUTODOCS_URL,
      provider: "default",
      status: 200,
      byteCount: 91422,
      charCount: 1120,
      truncated: false,
      title: "Autodocs | Storybook docs",
      domain: "storybook.js.org",
      redirectCount: 0,
      durationMs: 700,
      startIndexPastEnd: false,
    },
  },
  riskLevel: "low",
});

/**
 * A fetch recorded before the daemon sent metadata. The source card comes from
 * the result's header lines instead, so old history reads as it always has.
 */
export const webFetchLegacyDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-2",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the autodocs page",
  input: {
    activity: "Reading the autodocs page",
    url: AUTODOCS_URL,
    max_chars: 20000,
  },
  result: [
    `Requested URL: ${AUTODOCS_URL}`,
    `Final URL: ${AUTODOCS_URL}`,
    "Status: 200",
    "Content:",
    ...AUTODOCS_PAGE,
  ].join("\n"),
  riskLevel: "low",
});

/**
 * A page cut short that may also need JavaScript to render: both warnings the
 * daemon flags in the metadata.
 */
export const webFetchNoticesDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-3",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the pricing page",
  input: {
    activity: "Reading the pricing page",
    url: "https://example.com/pricing",
    max_chars: 2000,
  },
  result: [
    "Requested URL: https://example.com/pricing",
    "Final URL: https://www.example.com/pricing",
    "Status: 200 OK",
    "Content-Type: text/html",
    "Notices:",
    "- Followed 1 redirect(s).",
    "- Output truncated by max_chars=2000.",
    "- Extracted only 1840 chars of text from 412300 bytes of HTML (0.4%). Content may be JavaScript-rendered.",
    "Content:",
    "# Pricing",
    "",
    "Plans start at $12 per seat per month, billed annually.",
  ].join("\n"),
  activityMetadata: {
    webFetch: {
      url: "https://example.com/pricing",
      finalUrl: "https://www.example.com/pricing",
      provider: "default",
      status: 200,
      contentType: "text/html",
      byteCount: 412300,
      charCount: 1840,
      truncated: true,
      title: "Pricing | Example",
      domain: "www.example.com",
      redirectCount: 1,
      durationMs: 1210,
      startIndexPastEnd: false,
      mayRequireJavaScript: true,
    },
  },
  riskLevel: "low",
});

/** A page that answered with an HTTP error. */
export const webFetchErrorDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-4",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the changelog",
  input: {
    activity: "Reading the changelog",
    url: "https://example.com/changelog",
  },
  result: [
    "Error: HTTP 404",
    "",
    "Requested URL: https://example.com/changelog",
    "Final URL: https://example.com/changelog",
    "Status: 404 Not Found",
    "Content-Type: text/html",
    "Content:",
    "# Page not found",
  ].join("\n"),
  status: "error",
  activityMetadata: {
    webFetch: {
      url: "https://example.com/changelog",
      finalUrl: "https://example.com/changelog",
      provider: "default",
      status: 404,
      contentType: "text/html",
      byteCount: 1320,
      charCount: 16,
      truncated: false,
      title: "Page not found",
      domain: "example.com",
      redirectCount: 0,
      durationMs: 310,
      startIndexPastEnd: false,
      errorMessage: "Error: HTTP 404",
    },
  },
  riskLevel: "low",
});

/** A fetch still in flight: the url it asked for, and no page yet. */
export const webFetchRunningDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-fetch-5",
  toolName: "web_fetch",
  title: "Fetching a webpage",
  activity: "Reading the autodocs page",
  input: { activity: "Reading the autodocs page", url: AUTODOCS_URL },
  status: "running",
  riskLevel: "low",
});

/**
 * `ask_question`, answered. The record the daemon persists carries the
 * questions as asked and the user's decision for each, which is what the
 * drawer reads: an option, typed text, and one left unanswered.
 */
export const askQuestionDetail: ToolDetailPayload = payload({
  toolCallId: "tc-ask-1",
  toolName: "ask_question",
  title: "Asking a question",
  activity: "Checking which release to triage",
  input: {
    activity: "Checking which release to triage",
    questions: [
      {
        question: "Which release should I triage first?",
        options: [
          { id: "latest", label: "The latest release" },
          { id: "blocked", label: "The blocked release" },
        ],
      },
    ],
  },
  result: "The user chose: The blocked release.",
  answeredQuestion: {
    requestId: "req-1",
    overall: "completed",
    questions: [
      {
        id: "q1",
        question: "Which release should I triage first?",
        description: "Both have failures waiting.",
        options: [
          {
            id: "latest",
            label: "The latest release",
            description: "Cut this morning.",
          },
          {
            id: "blocked",
            label: "The blocked release",
            description: "Held for two days.",
          },
        ],
      },
    ],
    responses: [{ questionId: "q1", decision: "option", optionId: "blocked" }],
  },
  riskLevel: "low",
});

/** A batch, showing each way a question can be answered. */
export const askQuestionBatchDetail: ToolDetailPayload = payload({
  toolCallId: "tc-ask-2",
  toolName: "ask_question",
  title: "Asking a question",
  activity: "Confirming how to group the failures",
  input: { activity: "Confirming how to group the failures" },
  result: "The user answered 2 of 3 questions.",
  answeredQuestion: {
    requestId: "req-2",
    overall: "completed",
    questions: [
      {
        id: "q1",
        question: "Group the failures by owning team or by file?",
        options: [
          { id: "team", label: "By owning team" },
          { id: "file", label: "By file" },
        ],
      },
      {
        id: "q2",
        question: "Where should the summary go?",
        options: [
          { id: "thread", label: "The release thread" },
          { id: "issue", label: "A new issue" },
        ],
      },
      {
        id: "q3",
        question: "Should I include the drafts?",
        options: [
          { id: "yes", label: "Include them" },
          { id: "no", label: "Leave them out" },
        ],
      },
    ],
    responses: [
      { questionId: "q1", decision: "option", optionId: "team" },
      {
        questionId: "q2",
        decision: "free_text",
        text: "Post it in the release thread and link the issue.",
      },
      { questionId: "q3", decision: "skipped" },
    ],
  },
  riskLevel: "low",
});

/**
 * A question answered before the daemon persisted answered records, so the
 * call carries the questions it asked and the model-facing result, and no
 * structured answer. The detail reads the input rather than showing nothing.
 */
export const askQuestionLegacyDetail: ToolDetailPayload = payload({
  toolCallId: "tc-ask-4",
  toolName: "ask_question",
  title: "Asking a question",
  activity: "Checking which release to triage",
  input: {
    activity: "Checking which release to triage",
    questions: [
      {
        question: "Which release should I triage first?",
        description: "Both have failures waiting.",
        options: [
          {
            id: "latest",
            label: "The latest release",
            description: "Cut this morning.",
          },
          {
            id: "blocked",
            label: "The blocked release",
            description: "Held for two days.",
          },
        ],
      },
    ],
  },
  result: "The user chose: The blocked release.",
  riskLevel: "low",
});

/** A question still waiting on the user. */
export const askQuestionRunningDetail: ToolDetailPayload = payload({
  toolCallId: "tc-ask-3",
  toolName: "ask_question",
  title: "Asking a question",
  activity: "Checking which release to triage",
  input: { activity: "Checking which release to triage" },
  status: "running",
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

/** A search still in flight: the query, and no sources yet. */
export const webSearchRunningDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-search-3",
  toolName: "web_search",
  title: "Searching the web",
  activity: "Searching for Storybook autodocs configuration",
  kind: "web_search",
  input: { activity: "Searching the web", query: "storybook autodocs tag" },
  searchQuery: "storybook autodocs tag",
  searchResults: [],
  status: "running",
});

/** A search the user did not approve. Its result is the note to the model. */
export const webSearchDeniedDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-search-4",
  toolName: "web_search",
  title: "Searching the web",
  activity: "Searching for Storybook autodocs configuration",
  kind: "web_search",
  input: { activity: "Searching the web", query: "storybook autodocs tag" },
  searchQuery: "storybook autodocs tag",
  searchResults: [],
  result:
    'Permission denied. The "web_search" tool was not allowed. Do NOT retry this tool call immediately.',
  status: "denied",
});

/** A search that finished and found nothing. */
export const webSearchNoSourcesDetail: ToolDetailPayload = payload({
  toolCallId: "tc-web-search-5",
  toolName: "web_search",
  title: "Searching the web",
  activity: "Searching for an obscure configuration flag",
  kind: "web_search",
  input: { activity: "Searching the web", query: "storybook autodocs zz-flag" },
  searchQuery: "storybook autodocs zz-flag",
  searchResults: [],
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

import type { Meta, StoryObj } from "@storybook/react-vite";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import {
  bashDeniedDetail,
  bashDetail,
  bashErrorDetail,
  bashStreamingDetail,
  codeSearchDetail,
  fileEditDetail,
  fileReadDetail,
  fileReadEmptyDetail,
  fileReadMissingDetail,
  fileWriteDetail,
  largeOutputDetail,
  managedWorkspaceDetail,
  mcpDetail,
  mcpSqlDetail,
  minimalDetail,
  recallDetail,
  rememberDetail,
  riskVariant,
  skillExecuteDetail,
  skillLoadDetail,
  skillLoadErrorDetail,
  skillLoadLongDetail,
  skillLoadRunningDetail,
  subagentSpawnDetail,
  thinkingDetail,
  unknownToolDetail,
  webFetchDetail,
  webSearchDetail,
  webSearchErrorDetail,
} from "@/domains/chat/components/tool-detail-story-fixtures";

import { ToolDetailPanel } from "./tool-detail-panel";

/**
 * Catalogue of every tool-call detail treatment the side panel can produce
 * today (LUM-3509). This is an inventory of current behaviour, not a proposal:
 * nothing here is a redesign, and a story that reads badly is the finding.
 *
 * ## What renders what
 *
 * `ToolDetailBody` looks the tool name up in `tool-activity-renderers.ts`.
 * Shell, file edits, the two skill tools and the two web tools have bodies of
 * their own; everything else, native or third-party, falls back to the raw
 * JSON input and a clamped result.
 *
 * ## What the header owns
 *
 * Every panel that hosts a `ToolDetailBody` heads it with
 * `ToolDetailHeaderTitle`: the activity sentence, and under it the tool with
 * its risk pill. Nothing in the body repeats any of that. The activity does
 * appear once more inside the raw JSON, because `activity` is a real input key
 * the tools send alongside `command` / `path`, and that block is the raw input.
 *
 * The sentence wraps to two lines rather than truncating on one: most activity
 * sentences are longer than a single line at the drawer's 400px default, and
 * the native tooltip carries the tail of the rest.
 *
 * ## Coverage matrix
 *
 * "Volume rank" orders the families by how often they are called, 1 being the
 * most. It is here to rank design work. The underlying measurements are
 * internal and live on LUM-3509 rather than in this repository.
 *
 * | Family | Renderer today | Volume rank | Stories | Readability gap |
 * | --- | --- | --- | --- | --- |
 * | Files (`file_read` / `_write` / `_edit` / `_list`, host variants) | `file_edit` purpose-built, rest generic | 1 | FileRead, FileReadEmptyOutput, FileReadError, FileWrite, FileEdit, MinimalOutput | `file_edit` renders a unified diff. `file_write` still shows the written body as a JSON string literal with escaped newlines, which is the next one worth a body of its own. |
 * | Shell (`bash`, `host_bash`) | purpose-built | 2 | Bash, BashStreaming, BashError, BashDenied, LargeOutput | The command on a prompt line, its output beneath, as two labelled things. |
 * | Memory (`remember`, `recall`) | generic | 3 | Remember, Recall | `recall` returns a ranked list and renders as flat preformatted text; `remember` spends the full section chrome on a one-line acknowledgement. |
 * | Web (`web_search`, `web_fetch`) | purpose-built | 4 | WebSearchKind, WebSearchError, WebFetch | Registered like any other renderer, so a search reads the same from every panel. A failed search falls through to the generic body by design. |
 * | Skills (`skill_load`, `skill_execute`) | purpose-built | 5 | SkillLoad, SkillLoadLongBody, SkillLoadError, SkillLoadRunning, SkillExecute | The only tools with native treatment, and `skill_execute` is close to unused, so most of this investment sits on the rarer of the pair. |
 * | MCP (`mcp__*`) | generic | 6 | McpTool, McpToolHighRisk | The wire name goes through `titleCaseToolName`, so `mcp__analytics__exec` is titled "Mcp Analytics Exec": server and tool are not separated and the transport prefix is shown as a word. |
 * | Managed workspace tools | generic | mixed | ManagedWorkspaceTool | Nested-object inputs are the worst case for the raw JSON block. |
 * | Unenumerable third-party | generic | mixed | UnknownThirdPartyTool | The fallback that has to stay good, since we cannot write a renderer per vendor. |
 * | Reasoning (`kind: "thinking"`) | purpose-built | n/a | Thinking | Renders markdown properly. No gap. |
 *
 * ## States, and which are exercised
 *
 * | State | Story | Note |
 * | --- | --- | --- |
 * | Running, no output yet | SkillLoadRunning | Falls back to a bare "Running" line. |
 * | Running, streaming stdout | BashStreaming | Live `tool_output_chunk` tail. |
 * | Completed | most stories | |
 * | Error | BashError, FileReadError, SkillLoadError | The panel styles an error result identically to a successful one; only the text says it failed. |
 * | Denied or timed out | BashDenied | Output says the call was not approved and did not run. Both a declined confirmation and one that timed out land here. |
 * | Empty output | FileReadEmptyOutput | Output reports that the tool returned nothing, rather than disappearing. |
 * | Very large output | LargeOutput | `CodeBlock` clamps behind Show more; the daemon's cap is 400,000 characters. |
 * | Nested JSON input | ManagedWorkspaceTool, UnknownThirdPartyTool | |
 * | Risk levels | RiskLow, RiskMedium, RiskHigh, RiskWorkspace, RiskUnknown, RiskAbsent | A pill in the header, with the tolerance sentence on hover. Levels with no tolerance tier carry no tooltip. The neutral pills read faintly against the panel ground, which is unresolved. |
 * | Narrow or mobile | MobileWidth | Same panel inside the drawer at 390px. |
 *
 * ## Suggested order for follow-up design slices
 *
 * Ranked by how many calls each slice improves against how much design it
 * needs, which puts the two families the design lead named first.
 *
 * 1. `file_write` as an editor view, the largest readability win left.
 * 2. Memory. `recall` as a result list rather than flat text.
 * 3. MCP naming (LUM-3511). Low volume, but the title is wrong on every call
 *    rather than merely plain.
 *
 * Syntax highlighting is deliberately absent from all of these: there is no
 * highlighter in the repository, and adding one is a dependency call that can
 * be made later without changing any of these shapes.
 */
const meta: Meta<typeof ToolDetailPanel> = {
  title: "Chat/ToolDetailPanel",
  component: ToolDetailPanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      story: {
        /**
         * Each story mounts a full `AnimatedRightDrawer` at `h-screen`, and
         * autodocs renders every story on one page. Inline that means 33
         * viewport-tall frames stacked into a page tens of thousands of pixels
         * long, which stalls a third of the previews on their skeleton and is
         * unreviewable even when it does settle. Iframed previews give each
         * story its own sized viewport, so the catalogue is a page a person
         * can actually scroll.
         */
        inline: false,
        height: "620px",
      },
    },
  },
  args: {
    onClose: () => {},
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <Story />
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ToolDetailPanel>;

// ---------------------------------------------------------------------------
// Shell, the highest-volume family on the generic renderer
// ---------------------------------------------------------------------------

/** `bash`, the single most-called tool: the command, then what it printed. */
export const Bash: Story = { args: { detail: bashDetail } };

/** `bash` still running, with the live stdout tail under Output. */
export const BashStreaming: Story = { args: { detail: bashStreamingDetail } };

/**
 * A failed command. The result is a compiler error, and the panel frames it in
 * exactly the same neutral `<pre>` a successful run gets.
 */
export const BashError: Story = { args: { detail: bashErrorDetail } };

/**
 * A denied call. Output says the call was not approved and did not run, which
 * is also what a confirmation that timed out shows: `deriveToolStepStatus`
 * folds both into this status.
 */
export const BashDenied: Story = { args: { detail: bashDeniedDetail } };

// ---------------------------------------------------------------------------
// Files, the largest family by volume
// ---------------------------------------------------------------------------

/** `file_read`. The file body renders as preformatted text with no syntax colour. */
export const FileRead: Story = { args: { detail: fileReadDetail } };

/**
 * `file_read` on an empty file. An empty string is a result, so Output reports
 * that the tool returned nothing instead of vanishing.
 */
export const FileReadEmptyOutput: Story = {
  args: { detail: fileReadEmptyDetail },
};

/** `file_read` on a path that does not exist. */
export const FileReadError: Story = { args: { detail: fileReadMissingDetail } };

/**
 * `file_write`. The written file body is a JSON string literal with escaped
 * newlines, which is the clearest argument for the editor treatment.
 */
export const FileWrite: Story = { args: { detail: fileWriteDetail } };

/** `file_edit`. The before and after pair rendered as the diff it is. */
export const FileEdit: Story = { args: { detail: fileEditDetail } };

/** A one-line input and a short list output: the panel at its least dense. */
export const MinimalOutput: Story = { args: { detail: minimalDetail } };

// ---------------------------------------------------------------------------
// Memory and search
// ---------------------------------------------------------------------------

/** `remember`. Full section chrome around a one-line acknowledgement. */
export const Remember: Story = { args: { detail: rememberDetail } };

/** `recall`. A ranked result list flattened into preformatted text. */
export const Recall: Story = { args: { detail: recallDetail } };

/** `code_search`, the widest native input shape. */
export const CodeSearch: Story = { args: { detail: codeSearchDetail } };

/**
 * `subagent_spawn`, the one native tool that almost never sends an `activity`
 * key, so the header falls back to the phase title where the others show a
 * sentence.
 */
export const SubagentSpawn: Story = { args: { detail: subagentSpawnDetail } };

// ---------------------------------------------------------------------------
// Managed workspace, MCP, and the unenumerable tail
// ---------------------------------------------------------------------------

/** A managed workspace tool. Nested-object input is the worst case for raw JSON. */
export const ManagedWorkspaceTool: Story = {
  args: { detail: managedWorkspaceDetail },
};

/**
 * An MCP tool. `titleCaseToolName` turns `mcp__analytics__exec` into
 * "Mcp Analytics Exec", showing the transport prefix to the user as a word and
 * leaving the server and tool undifferentiated.
 */
export const McpTool: Story = { args: { detail: mcpDetail } };

/** A second MCP server at high risk, showing the naming is not vendor-specific. */
export const McpToolHighRisk: Story = { args: { detail: mcpSqlDetail } };

/**
 * An integration we cannot enumerate. One story stands in for the whole tail,
 * since every unregistered tool name reaches exactly this rendering.
 */
export const UnknownThirdPartyTool: Story = {
  args: { detail: unknownToolDetail },
};

// ---------------------------------------------------------------------------
// Content-shape edges
// ---------------------------------------------------------------------------

/**
 * A long result, clamped behind Show more. Tool results reach the panel at up
 * to the daemon's 400,000 character cap, which is not a height a panel absorbs.
 */
export const LargeOutput: Story = { args: { detail: largeOutputDetail } };

// ---------------------------------------------------------------------------
// Risk levels
// ---------------------------------------------------------------------------

/** Low risk: success tone, with the tolerance hint. */
export const RiskLow: Story = {
  args: { detail: riskVariant("low") },
};

/** Medium risk: warning tone. */
export const RiskMedium: Story = {
  args: { detail: riskVariant("medium") },
};

/** High risk: error tone. */
export const RiskHigh: Story = {
  args: { detail: riskVariant("high") },
};

/**
 * `workspace`, the level a sandbox auto-approval maps to. Neutral tone and no
 * tolerance hint, since it is not a tolerance tier.
 */
export const RiskWorkspace: Story = {
  args: { detail: riskVariant("workspace") },
};

/**
 * An unrecognised level from the wire. Falls through to a neutral notice whose
 * label is the raw string, capitalised.
 */
export const RiskUnknown: Story = {
  args: { detail: riskVariant("elevated") },
};

/** No risk assessment at all, which suppresses the notice entirely. */
export const RiskAbsent: Story = {
  args: { detail: riskVariant(undefined) },
};

// ---------------------------------------------------------------------------
// Skills, the only tools with purpose-built renderers
// ---------------------------------------------------------------------------

/**
 * `skill_load` with a purpose-built body: the skill's identity and a View
 * action up top, the manifest as a scannable tool list, and the instruction
 * markdown rendered rather than dumped as a `<pre>`.
 */
export const SkillLoad: Story = { args: { detail: skillLoadDetail } };

/**
 * A realistically long skill body: Output clamps it behind "Show more", and
 * the Clean/Raw switch flips between the rendered markdown and the daemon's
 * verbatim result, header lines and tool manifest included.
 */
export const SkillLoadLongBody: Story = {
  args: { detail: skillLoadLongDetail },
};

/** A failed `skill_load`, whose error reads as prose rather than raw output. */
export const SkillLoadError: Story = { args: { detail: skillLoadErrorDetail } };

/** `skill_load` still in flight, before the instruction body lands. */
export const SkillLoadRunning: Story = {
  args: { detail: skillLoadRunningDetail },
};

/**
 * `skill_execute` with its envelope unwrapped: the inner tool leads, and its
 * parameters render as a labelled list instead of nested JSON.
 */
export const SkillExecute: Story = { args: { detail: skillExecuteDetail } };

// ---------------------------------------------------------------------------
// Other payload kinds routed through the same panel
// ---------------------------------------------------------------------------

/** The reasoning variant: markdown, no input or output sections, no risk notice. */
export const Thinking: Story = { args: { detail: thinkingDetail } };

/**
 * A `kind: "web_search"` payload. The query and its sources render as a search
 * view in every panel that hosts a tool detail, because the renderer is looked
 * up in one registry rather than branched on per panel.
 */
export const WebSearchKind: Story = { args: { detail: webSearchDetail } };

/**
 * A failed search. With no sources to lay out it falls through to the generic
 * body on purpose, so the error reads the way any other failed tool's does.
 */
export const WebSearchError: Story = { args: { detail: webSearchErrorDetail } };

/** `web_fetch`. The fetched page, not the header-and-marker envelope. */
export const WebFetch: Story = { args: { detail: webFetchDetail } };

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The panel at a phone width. The drawer caps its own width below its minimum,
 * so this is the geometry the mobile overlay puts the same body through.
 */
export const MobileWidth: Story = {
  args: { detail: fileEditDetail },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

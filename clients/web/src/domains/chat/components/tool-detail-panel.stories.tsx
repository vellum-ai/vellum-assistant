import type { Meta, StoryObj } from "@storybook/react-vite";

import { useInteractionStore } from "@/domains/chat/interaction-store";
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
  wideTableOutputDetail,
  manyShortLinesDetail,
  tallNestedParameterDetail,
  tallTableParameterDetail,
  longTextParameterDetail,
  managedWorkspaceDetail,
  mcpDetail,
  mcpSqlDetail,
  minimalDetail,
  recallDetail,
  recallNothingFoundDetail,
  recallTextOnlyDetail,
  recordListDetail,
  rememberDetail,
  riskVariant,
  skillExecuteDetail,
  skillLoadDetail,
  skillLoadErrorDetail,
  skillLoadLongDetail,
  skillLoadManyToolsDetail,
  skillLoadRunningDetail,
  subagentSpawnDetail,
  thinkingDetail,
  unknownToolDetail,
  askQuestionBatchDetail,
  askQuestionDetail,
  askQuestionLegacyDetail,
  askQuestionRunningDetail,
  webFetchDetail,
  webFetchErrorDetail,
  webFetchLegacyDetail,
  webFetchLongPageDetail,
  webFetchNoticesDetail,
  webFetchRunningDetail,
  webSearchDeniedDetail,
  webSearchDetail,
  webSearchErrorDetail,
  webSearchNoSourcesDetail,
  webSearchRunningDetail,
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
 * their own; everything else, native or third-party, falls back to its
 * parameters as labelled fields, the raw JSON input behind a disclosure, and a
 * clamped result.
 *
 * ## What the header owns
 *
 * Every panel that hosts a `ToolDetailBody` heads it with
 * `ToolDetailHeaderTitle`: the activity sentence, and under it the tool with
 * its risk pill. Nothing in the body repeats any of that. The activity does
 * appear once more inside the raw JSON, because `activity` is a real input key
 * the tools send alongside `command` / `path`, and that block is the raw input.
 * The parameter fields leave it out, since the header already shows it.
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
 * | Files (`file_read` / `_write` / `_edit` / `_list`, host variants) | changing tools purpose-built, reading tools generic | 1 | FileRead, FileReadEmptyOutput, FileReadError, FileWrite, FileEdit, MinimalOutput | `file_edit` and `file_write` share one body: an edit renders a unified diff, a write renders the file under its path, and both label the section by whether the call succeeded. `file_read` stays generic because its file comes back in the result, which the Output section already renders as text. |
 * | Shell (`bash`, `host_bash`) | purpose-built | 2 | Bash, BashStreaming, BashError, BashDenied, LargeOutput | The command and its output as two labelled blocks, rather than a JSON object quoting one. |
 * | Memory (`remember`, `recall`) | purpose-built | 3 | Remember, Recall, RecallTextOnly, RecallNothingFound | Read from each tool's structured result: `remember` lists the facts saved, `recall` the query, the answer and the evidence, each piece opening the file or conversation it came from. A recall recorded without a structured result shows its text as written. |
 * | Web (`web_search`, `web_fetch`) | purpose-built | 4 | WebSearchKind, WebSearchRunning, WebSearchDenied, WebSearchNoSources, WebSearchError, AskQuestion, AskQuestionBatch, AskQuestionLegacy, AskQuestionOutstanding, WebFetch, WebFetchLegacy, WebFetchNotices, WebFetchError, WebFetchRunning | Registered like any other renderer, so a search reads the same from every panel. A running or refused search says so; only a finished one with no results says it found none. A failed search falls through to the generic body by design. |
 * | Skills (`skill_load`, `skill_execute`) | purpose-built | 5 | SkillLoad, SkillLoadLongBody, SkillLoadError, SkillLoadRunning, SkillExecute | The only tools with native treatment, and `skill_execute` is close to unused, so most of this investment sits on the rarer of the pair. |
 * | MCP (`mcp__*`) | generic | 6 | McpTool, McpToolHighRisk | The wire name goes through `titleCaseToolName`, so `mcp__analytics__exec` is titled "Mcp Analytics Exec": server and tool are not separated and the transport prefix is shown as a word. |
 * | Managed workspace tools | generic | mixed | ManagedWorkspaceTool | An object parameter nests its fields in a bordered group, each label above its value, with short lists and small objects on one line; only a value nested past four levels falls back to JSON. |
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
 * | Structured output | McpTool, UnknownThirdPartyTool, RecordListParameter, WideTableOutput | A result that is a JSON object or list lays out the way the input does, with the result exactly as received under Raw output. Anything else, and an error or a streamed tail, stays a code block. |
 * | Taller than the fold | ManyShortLinesOutput, TallTableParameter, TallNestedParameter | Any value taller than the fold folds behind Show more, measured at the width it is drawn at: many short lines as readily as one long paragraph, and a table or nested group as one value. |
 * | Very large output | LargeOutput | `CodeBlock` clamps behind Show more; the daemon's cap is 400,000 characters. |
 * | Nested JSON input | ManagedWorkspaceTool, UnknownThirdPartyTool | Structure nests as labelled fields, short lists and small objects read on one line, and the raw JSON sits behind a disclosure. |
 * | Long and multi-line text | LongTextParameter | A value on one line reads inline however long it is, and folds behind Show more once it runs long; text with line breaks keeps its lines in a code block. |
 * | List of records | RecordListParameter | A list of same-shaped objects reads as a table, one column per key; a record missing a key leaves an empty cell. |
 * | Risk levels | RiskLow, RiskMedium, RiskHigh, RiskWorkspace, RiskUnknown, RiskAbsent | A pill in the header, with the tolerance sentence on hover, or beside the pill as text where the pointer cannot hover. Levels with no tolerance tier carry neither. The neutral pills read faintly against the panel ground, which is unresolved. |
 * | Narrow or mobile | MobileWidth | Same panel inside the drawer at 390px. |
 *
 * ## Suggested order for follow-up design slices
 *
 * Ranked by how many calls each slice improves against how much design it
 * needs, which puts the two families the design lead named first.
 *
 * 1. Memory. `recall` as a result list rather than flat text.
 * 2. MCP naming (LUM-3511). Low volume, but the title is wrong on every call
 *    rather than merely plain.
 * 3. A true diff for file changes (LUM-3403). The daemon already returns
 *    whole-file before and after on every completed file call; the client
 *    discards it, and it is not persisted, so this needs a daemon field
 *    before the panel can show more than the requested hunk.
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
 * `file_write`. The file renders under its path rather than as a JSON string
 * literal. It shares `FileChangeDetail` with `file_edit`, so a write that was
 * declined or failed says so in the same words an edit does.
 */
export const FileWrite: Story = { args: { detail: fileWriteDetail } };

/** `file_edit`. The before and after pair rendered as the diff it is. */
export const FileEdit: Story = { args: { detail: fileEditDetail } };

/** A one-line input and a short list output: the panel at its least dense. */
export const MinimalOutput: Story = { args: { detail: minimalDetail } };

// ---------------------------------------------------------------------------
// Memory and search
// ---------------------------------------------------------------------------

/** `remember`: the facts it saved, as a list under whether they were saved. */
export const Remember: Story = { args: { detail: rememberDetail } };

/**
 * `recall`: what it searched for and where, the answer, and the evidence the
 * answer stands on.
 */
export const Recall: Story = { args: { detail: recallDetail } };

/**
 * `recall` from history recorded before it reported a structured result. Its
 * text reads as the markdown it was written as.
 */
export const RecallTextOnly: Story = { args: { detail: recallTextOnlyDetail } };

/** `recall` that found nothing, and says which place it could not search. */
export const RecallNothingFound: Story = {
  args: { detail: recallNothingFoundDetail },
};

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

/**
 * A managed workspace tool. Its nested-object parameter renders as labelled
 * fields, with its short lists on one line.
 */
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
 * Forty short lines of output. Short in characters but taller than the fold,
 * so it folds by the height it is drawn at.
 */
export const ManyShortLinesOutput: Story = {
  args: { detail: manyShortLinesDetail },
};

/** A table parameter of twenty rows, folded as one value. */
export const TallTableParameter: Story = {
  args: { detail: tallTableParameterDetail },
};

/** A nested parameter group of twelve fields, folded as one value. */
export const TallNestedParameter: Story = {
  args: { detail: tallNestedParameterDetail },
};

/**
 * A long result, clamped behind Show more. Tool results reach the panel at up
 * to the daemon's 400,000 character cap, which is not a height a panel absorbs.
 */
export const LargeOutput: Story = { args: { detail: largeOutputDetail } };

/**
 * An output table wider than the drawer and taller than a screen: thirty
 * records with ten keys each. Columns take the width of their values on one
 * line and the table scrolls sideways; the long `website` column wraps at the
 * width cap.
 */
export const WideTableOutput: Story = {
  args: { detail: wideTableOutputDetail },
};

/**
 * Long and multi-line text. The note is one long line, so it reads inline and
 * folds behind Show more once it runs past the clamp; the checklist is short
 * but has line breaks, so it keeps them in a code block.
 */
export const LongTextParameter: Story = {
  args: { detail: longTextParameterDetail },
};

/**
 * A parameter that is a list of same-shaped records. It reads as a table with
 * a column per key, in the order the keys first appear, instead of a numbered
 * group of boxes. A record that omits a key leaves that cell empty, since an
 * import or a query result commonly leaves a column out per row; a key present
 * in fewer than half the records, or more than twelve keys, falls back to the
 * nested group. Rows past the first hundred are counted under the table, and
 * the raw input keeps them all.
 */
export const RecordListParameter: Story = {
  args: { detail: recordListDetail },
};

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
/** A skill advertising many tools: the list folds, one control for all of it. */
export const SkillLoadManyTools: Story = {
  args: { detail: skillLoadManyToolsDetail },
};

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

/** A search still running says so, rather than that it found no sources. */
export const WebSearchRunning: Story = {
  args: { detail: webSearchRunningDetail },
};

/** A refused search says it did not run, never the note to the model. */
export const WebSearchDenied: Story = {
  args: { detail: webSearchDeniedDetail },
};

/** Only a search that finished with no results says it found no sources. */
export const WebSearchNoSources: Story = {
  args: { detail: webSearchNoSourcesDetail },
};

/**
 * `ask_question`, answered: what was asked, and what the user chose. Read from
 * the record the daemon persists, not the input the model wrote.
 */
export const AskQuestion: Story = { args: { detail: askQuestionDetail } };

/** A batch: an option, typed text, and a question left unanswered. */
export const AskQuestionBatch: Story = {
  args: { detail: askQuestionBatchDetail },
};

/**
 * A question recorded before answered records existed. There is no structured
 * answer to read, so the questions come from the call's own input and the
 * result says what the user chose.
 */
export const AskQuestionLegacy: Story = {
  args: { detail: askQuestionLegacyDetail },
};

/**
 * A question still waiting on the user. The options as offered come from the
 * live prompt, the one the card above the composer is drawn from.
 */
export const AskQuestionOutstanding: Story = {
  args: { detail: askQuestionRunningDetail },
  beforeEach: () => {
    useInteractionStore.setState({
      pendingQuestion: {
        requestId: "req-3",
        toolUseId: askQuestionRunningDetail.toolCallId,
        entries: [
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
      },
    });
    return () => {
      useInteractionStore.setState({ pendingQuestion: null });
    };
  },
};

/** `web_fetch`. The fetched page, not the header-and-marker envelope. */
export const WebFetch: Story = { args: { detail: webFetchDetail } };

/** A long page folds, so the rest of the panel stays reachable. */
export const WebFetchLongPage: Story = {
  args: { detail: webFetchLongPageDetail },
};

/** A fetch recorded before the metadata existed reads as it always has. */
export const WebFetchLegacy: Story = { args: { detail: webFetchLegacyDetail } };

/** A page cut short, which may also need JavaScript, warns about both. */
export const WebFetchNotices: Story = {
  args: { detail: webFetchNoticesDetail },
};

/** A page that answered with an HTTP error. */
export const WebFetchError: Story = { args: { detail: webFetchErrorDetail } };

/** A fetch still in flight says so, the way every running tool does. */
export const WebFetchRunning: Story = {
  args: { detail: webFetchRunningDetail },
};

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

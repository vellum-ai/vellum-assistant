import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ToolDetailPayload } from "@/stores/viewer-store";

import { Notice, Typography } from "@vellumai/design-library";

import { SectionLabel } from "@/components/detail-primitives";
import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import { DetailShell } from "@/components/detail-shell";
import {
  bashDetail,
  bashErrorDetail,
  bashStreamingDetail,
  fileEditDetail,
} from "@/domains/chat/components/tool-detail-story-fixtures";
import { BashDetail } from "@/domains/chat/components/tool-activity/bash-detail";
import { FileEditDetail } from "@/domains/chat/components/tool-activity/file-edit-detail";
import { RiskChip } from "@/domains/chat/components/tool-activity/risk-chip";
import { ToolMetaRow } from "@/domains/chat/components/tool-activity/tool-meta-row";
import { friendlyName } from "@/domains/chat/components/tool-call-chip/utils";
import { ToolDetailPanel } from "@/domains/chat/components/tool-detail-panel";
import {
  getRiskBadgeWeakStyle,
  getRiskNoticeTone,
  getRiskToleranceHint,
} from "@/domains/chat/utils/risk";
import { FileText, SquareTerminal } from "lucide-react";

/**
 * Proposals for the tool-specific renderers, so the choice can be made against
 * something real rather than described.
 *
 * **None of these are registered.** `tool-activity-renderers.ts` is unchanged,
 * so nothing here reaches the product. Each proposal is a real component built
 * from primitives the repository already has, which is also the point: the
 * question is which of them we want, not whether they are affordable.
 *
 * Each pair below is "Current" then "Proposed", on the same fixture, in the
 * real drawer at its real 400px default width.
 *
 * ## What these proposals do not decide
 *
 * - **Syntax highlighting.** There is no highlighter in the repository, and
 *   adding one is a dependency and bundle-size call. Everything here is
 *   monochrome, and highlighting would be additive to the same shapes.
 * - **Whether risk stays first.** `RiskChip` shows the information as a pill;
 *   where the pill belongs in the panel is a layout decision, not a rendering
 *   one.
 *
 * ## What they reuse
 *
 * Nothing here adds a dependency.
 *
 * - The diff is `FileDiffView` + `computeLineDiff` + `DiffRows`, which already
 *   render diffs for ACP runs and skill revision history. `computeLineDiff` is
 *   a dependency-free LCS and `DiffRows` soft-wraps rather than scrolling,
 *   which is what makes a diff legible at 400px. Shipping it means lifting
 *   `FileDiffView` out of `acp-run-chat-view/` once it has a second consumer.
 * - The risk pill is `RiskBadge`, which matches the macOS `RiskBadgeView`
 *   convention and has tests and stories, and which nothing in the app
 *   currently renders.
 * - The terminal reuses `ClampedContent` and `CopyButton`.
 */
const meta: Meta = {
  title: "Chat/ToolDetailPanel Proposals",
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "620px" } },
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
type Story = StoryObj;

/**
 * Frames a proposal the way the panel composes one: the drawer shell with the
 * activity sentence as its title, the meta row naming the tool and its risk,
 * then the renderer's body. Composed here rather than through
 * `ToolDetailPanel` because these renderers are deliberately not registered.
 */
function Proposed({
  detail,
  Glyph,
  variant = "row",
  children,
}: {
  detail: ToolDetailPayload;
  Glyph: typeof FileText;
  /**
   * Where the tool name and its risk sit. `row` puts them under the header;
   * `header` folds them into it, which drops the second copy of the glyph.
   */
  variant?: "row" | "header" | "subtitle";
  children: React.ReactNode;
}) {
  const title = detail.activity || detail.title;
  if (variant === "subtitle") {
    return (
      <DetailShell
        Glyph={Glyph}
        titleNode={
          <div className="min-w-0 py-0.5">
            <Typography
              variant="title-medium"
              as="div"
              className="truncate leading-snug text-[var(--content-default)]"
            >
              {title}
            </Typography>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <Typography
                variant="body-small-lighter"
                as="span"
                className="truncate text-[var(--content-tertiary)]"
              >
                {friendlyName(detail.toolName)}
              </Typography>
              <RiskChip level={detail.riskLevel} />
            </div>
          </div>
        }
        closeLabel="Close"
        closeVariant="outlined"
        onClose={() => {}}
      >
        {children}
      </DetailShell>
    );
  }
  if (variant === "header") {
    return (
      <DetailShell
        Glyph={Glyph}
        titleNode={
          <div className="min-w-0 py-0.5">
            <Typography
              variant="title-medium"
              as="div"
              className="truncate leading-snug text-[var(--content-default)]"
            >
              {title}
            </Typography>
            <Typography
              variant="body-small-lighter"
              as="div"
              className="truncate text-[var(--content-tertiary)]"
            >
              {friendlyName(detail.toolName)}
            </Typography>
          </div>
        }
        headerTrailing={<RiskChip level={detail.riskLevel} />}
        closeLabel="Close"
        closeVariant="outlined"
        onClose={() => {}}
      >
        {children}
      </DetailShell>
    );
  }
  return (
    <DetailShell
      Glyph={Glyph}
      title={title}
      closeLabel="Close"
      closeVariant="outlined"
      onClose={() => {}}
    >
      <div className="flex flex-col gap-5">
        <ToolMetaRow
          toolName={detail.toolName}
          input={detail.input}
          riskLevel={detail.riskLevel}
        />
        {children}
      </div>
    </DetailShell>
  );
}

// ---------------------------------------------------------------------------
// file_edit
// ---------------------------------------------------------------------------

/** What ships today: the before and after as two escaped JSON string literals. */
export const FileEditCurrent: Story = {
  render: () => <ToolDetailPanel detail={fileEditDetail} onClose={() => {}} />,
};

/**
 * Proposed: the same pair as a unified diff, through the renderer the skill
 * revision history and ACP runs already use.
 */
export const FileEditProposed: Story = {
  render: () => (
    <Proposed detail={fileEditDetail} Glyph={FileText}>
      <FileEditDetail
        detail={fileEditDetail}
        result={fileEditDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

/** What ships today: the command quoted inside a JSON object, output below. */
export const BashCurrent: Story = {
  render: () => <ToolDetailPanel detail={bashDetail} onClose={() => {}} />,
};

/** Proposed: a prompt line and its output on one surface. */
export const BashProposed: Story = {
  render: () => (
    <Proposed detail={bashDetail} Glyph={SquareTerminal}>
      <BashDetail
        detail={bashDetail}
        result={bashDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

/** Proposed, failing: the output carries the error tone rather than a label. */
export const BashProposedError: Story = {
  render: () => (
    <Proposed detail={bashErrorDetail} Glyph={SquareTerminal}>
      <BashDetail
        detail={bashErrorDetail}
        result={bashErrorDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError
      />
    </Proposed>
  ),
};

/** Proposed, running: the streamed tail lands in the same block. */
export const BashProposedRunning: Story = {
  render: () => (
    <Proposed detail={bashStreamingDetail} Glyph={SquareTerminal}>
      <BashDetail
        detail={bashStreamingDetail}
        result={undefined}
        streamedOutput={bashStreamingDetail.streamedOutput}
        isRunning
        isError={false}
      />
    </Proposed>
  ),
};

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

const LEVELS = ["low", "medium", "high", "workspace", "elevated"];

/**
 * What ships today: a section label and a full-width tone bar per call,
 * spending three lines on one word and a sentence.
 */
export const RiskCurrent: Story = {
  render: () => (
    <Proposed
      detail={{ ...bashDetail, activity: "Risk, as it renders today" }}
      Glyph={FileText}
    >
      <div className="flex flex-col gap-5">
        {LEVELS.map((level) => {
          const style = getRiskBadgeWeakStyle(level);
          const hint = getRiskToleranceHint(level);
          return (
            <div key={level}>
              <SectionLabel>Risk Level</SectionLabel>
              <Notice tone={getRiskNoticeTone(level)}>
                <span className={style.text}>
                  {hint ? `${style.label} → ${hint}` : style.label}
                </span>
              </Notice>
            </div>
          );
        })}
      </div>
    </Proposed>
  ),
};

/**
 * Proposed: the level as a pill, the tolerance sentence on hover. Levels with
 * no tolerance tier (`workspace`, unrecognised) carry no tooltip, because
 * there is no sentence for them.
 *
 * Hover a pill to see the tooltip; it is the real one, so it needs a pointer.
 */
export const RiskProposed: Story = {
  render: () => (
    <Proposed
      detail={{ ...bashDetail, activity: "Risk, as a pill" }}
      Glyph={FileText}
    >
      <div className="flex flex-wrap items-center gap-2">
        {LEVELS.map((level) => (
          <RiskChip key={level} level={level} />
        ))}
      </div>
    </Proposed>
  ),
};

// ---------------------------------------------------------------------------
// Where the tool name and risk sit
// ---------------------------------------------------------------------------

/**
 * The glyph appears twice in the row variant: once in the header, once again
 * directly beneath it in the meta row. Folding the tool name into the header as
 * a subtitle and moving the pill to the header's trailing slot leaves one
 * glyph, one place naming the call, and no row between the header and the
 * substance.
 */
export const BashToolInHeader: Story = {
  render: () => (
    <Proposed detail={bashDetail} Glyph={SquareTerminal} variant="header">
      <BashDetail
        detail={bashDetail}
        result={bashDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

/** The same treatment on a file edit. */
export const FileEditToolInHeader: Story = {
  render: () => (
    <Proposed detail={fileEditDetail} Glyph={FileText} variant="header">
      <FileEditDetail
        detail={fileEditDetail}
        result={fileEditDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

/**
 * The pill on the tool-name line rather than the header's trailing slot, so the
 * activity sentence keeps the panel's full width instead of truncating to make
 * room for it.
 */
export const BashToolInSubtitle: Story = {
  render: () => (
    <Proposed detail={bashDetail} Glyph={SquareTerminal} variant="subtitle">
      <BashDetail
        detail={bashDetail}
        result={bashDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

/** The same treatment on a file edit. */
export const FileEditToolInSubtitle: Story = {
  render: () => (
    <Proposed detail={fileEditDetail} Glyph={FileText} variant="subtitle">
      <FileEditDetail
        detail={fileEditDetail}
        result={fileEditDetail.result}
        streamedOutput={undefined}
        isRunning={false}
        isError={false}
      />
    </Proposed>
  ),
};

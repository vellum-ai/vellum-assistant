/**
 * The "Output" section of a `skill_load` detail panel (Figma node
 * 7778-163402): a Clean/Raw switch over one card, clamped to a readable height
 * with a Show more control.
 *
 * `skill_load`'s output is the skill body itself — markdown that renders
 * properly (Clean) but that an operator sometimes needs to see verbatim, header
 * lines and tool manifest included (Raw). Those were two separate collapsed
 * disclosures; the segment control makes them one thing viewed two ways, which
 * is what they are.
 */

import { useState } from "react";

import { SegmentControl, Typography } from "@vellumai/design-library";

import { CopyButton, SectionLabel } from "@/components/detail-primitives";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

type OutputMode = "clean" | "raw";

const MODES = [
  { value: "clean" as const, label: "Clean" },
  { value: "raw" as const, label: "Raw" },
];

/**
 * Bodies longer than this collapse behind "Show more". Roughly a dozen lines of
 * prose — enough to tell what the skill does, short enough that the tools above
 * it stay on screen.
 */
const CLAMP_CHARS = 700;

/** Collapsed height of the clamped card, in px. */
const CLAMP_HEIGHT = 260;

export function SkillLoadOutput({
  /** Instruction markdown, header and tool manifest already stripped. */
  instructions,
  /** The tool's verbatim result, when one has landed. */
  raw,
  assistantId,
}: {
  instructions: string;
  raw: string;
  assistantId?: string | null;
}) {
  const [mode, setMode] = useState<OutputMode>("clean");
  const [expanded, setExpanded] = useState(false);

  // A skill whose body is nothing but the header and its tool manifest parses
  // to empty instructions; Raw is then the only view worth offering, so the
  // switch would be a control with one real choice.
  const hasClean = instructions !== "";
  const hasRaw = raw !== "";
  if (!hasClean && !hasRaw) {
    return null;
  }

  const activeMode: OutputMode = hasClean ? mode : "raw";
  const body = activeMode === "clean" ? instructions : raw;
  const clamped = body.length > CLAMP_CHARS && !expanded;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        {/* The row owns the spacing under the header, so the label drops its
            own bottom margin — otherwise it sits off-centre from the switch. */}
        <SectionLabel className="mb-0">Output</SectionLabel>
        {hasClean && hasRaw && (
          <SegmentControl
            items={MODES}
            value={activeMode}
            onChange={setMode}
            ariaLabel="Output format"
            // The control defaults to `w-full` for full-width pickers; here it
            // trails the section label, so it hugs its two segments instead.
            // The segments keep `flex-1`, so they stay equal width.
            className="w-auto shrink-0"
          />
        )}
      </div>

      <div className="relative rounded-xl bg-[var(--surface-overlay)] p-3">
        <div
          className="relative overflow-hidden"
          style={clamped ? { maxHeight: CLAMP_HEIGHT } : undefined}
        >
          {activeMode === "clean" ? (
            <ChatMarkdownMessage
              content={instructions}
              assistantId={assistantId}
            />
          ) : (
            <pre className="font-mono text-xs whitespace-pre-wrap break-words text-[var(--content-default)]">
              {raw}
            </pre>
          )}
          {clamped && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--surface-overlay)] to-transparent"
            />
          )}
        </div>

        {body.length > CLAMP_CHARS && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="mt-2 w-full border-t border-[var(--border-base)] pt-2 text-left"
          >
            <Typography
              variant="body-medium-default"
              as="span"
              className="text-[var(--content-default)]"
            >
              {expanded ? "Show less" : "Show more"}
            </Typography>
          </button>
        )}

        {activeMode === "raw" && <CopyButton text={raw} />}
      </div>
    </div>
  );
}

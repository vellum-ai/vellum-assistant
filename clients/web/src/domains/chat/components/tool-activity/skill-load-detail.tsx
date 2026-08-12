/**
 * Purpose-built activity UI for a `skill_load` call (LUM-2999), laid out to
 * Figma node 7778-163402: a "Used Skill" card carrying the skill's identity and
 * a View action, the tools the load unlocked, then the skill body under an
 * Output section with a Clean/Raw switch.
 *
 * The generic drawer rendered this call at its worst: `{"skill":"app-builder"}`
 * as raw JSON input, and the skill's entire instruction body — often thousands
 * of lines, including a machine-facing "## Available Tools" manifest — dumped
 * into a monospace `<pre>`.
 */

import { Notice, Skeleton } from "@vellumai/design-library";

import { SectionLabel } from "@/components/detail-primitives";
import { SkillLoadCard } from "@/domains/chat/components/tool-activity/skill-load-card";
import { SkillLoadOutput } from "@/domains/chat/components/tool-activity/skill-load-output";
import { SkillToolList } from "@/domains/chat/components/tool-activity/skill-tool-list";
import { parseSkillLoadActivity } from "@/domains/chat/utils/skill-activity";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";

/**
 * Placeholder for the sections still in flight while `skill_load` runs: the
 * tool manifest and the instruction body. Mirrors the real layout — bordered
 * tool cards over staggered prose lines — so the panel doesn't reflow when the
 * body lands.
 *
 * The skill card above is NOT skeletonised: the skill id comes from the call's
 * own input, so it's known immediately and showing it beats a shimmer.
 */
function SkillLoadSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading skill"
      className="flex flex-col gap-5"
    >
      <div>
        <SectionLabel>Provides</SectionLabel>
        <div className="flex flex-col gap-4">
          {[0, 1].map((row) => (
            <div key={row}>
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="mt-2 h-3 w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}

export function SkillLoadDetail({
  detail,
  result,
  isRunning,
  isError,
  assistantId,
}: ToolActivityRendererProps) {
  const {
    skillId,
    displayName,
    description,
    instructions,
    tools,
    errorMessage,
  } = parseSkillLoadActivity({ input: detail.input, result, isError });

  // The card's second line is the skill's description once the body lands, and
  // the load's own state until then — the description is the more useful thing
  // to say, and it's only absent while there's something else to report.
  const status = isRunning
    ? "Loading skill…"
    : errorMessage
      ? "Failed to load"
      : "";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>Used Skill</SectionLabel>
        <SkillLoadCard
          skillId={skillId}
          name={displayName || skillId || "Skill"}
          secondary={description || status}
          assistantId={assistantId}
        />
      </div>

      {errorMessage && (
        <Notice tone="error">
          <span className="whitespace-pre-wrap break-words">
            {errorMessage}
          </span>
        </Notice>
      )}

      {tools.length > 0 && (
        <div>
          <SectionLabel>Provides</SectionLabel>
          <SkillToolList tools={tools} />
        </div>
      )}

      {/* A failed load's "output" is the error text, which the notice above
          already shows in full — rendering it again as Output would say the
          same thing twice. */}
      {!errorMessage && (
        <SkillLoadOutput
          instructions={instructions}
          raw={typeof result === "string" ? result : ""}
          assistantId={assistantId}
        />
      )}

      {isRunning && !instructions && !errorMessage && <SkillLoadSkeleton />}
    </div>
  );
}

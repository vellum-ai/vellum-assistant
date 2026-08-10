/**
 * Purpose-built activity UI for a `skill_load` call (LUM-2999).
 *
 * The generic drawer rendered this call at its worst: `{"skill":"app-builder"}`
 * as raw JSON input, and the skill's entire instruction body — often thousands
 * of lines, including a machine-facing "## Available Tools" manifest — dumped
 * into a monospace `<pre>`. This renderer instead leads with the skill's
 * identity, turns the manifest into a scannable tool list, and renders the
 * instructions as actual markdown behind a disclosure.
 */

import { Sparkles } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { SkillToolList } from "@/domains/chat/components/tool-activity/skill-tool-list";
import { parseSkillLoadActivity } from "@/domains/chat/utils/skill-activity";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";

/**
 * Instruction bodies shorter than this render expanded; longer ones start
 * collapsed so the drawer opens on the skill's identity and tools rather than
 * a wall of prose the reader has to scroll past.
 */
const INSTRUCTIONS_AUTO_EXPAND_CHARS = 1200;

/** Leading skill identity row: glyph tile, skill id, and load status. */
function SkillIdentity({
  skillId,
  status,
}: {
  skillId: string;
  status: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-overlay)]">
        <Sparkles className="h-4 w-4 text-[var(--content-secondary)]" />
      </div>
      <div className="min-w-0">
        <Typography
          variant="body-medium-default"
          as="div"
          className="truncate text-[var(--content-default)]"
        >
          {skillId || "Skill"}
        </Typography>
        <Typography
          variant="body-small-default"
          as="div"
          className="text-[var(--content-secondary)]"
        >
          {status}
        </Typography>
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
  const { skillId, instructions, tools, errorMessage } = parseSkillLoadActivity(
    { input: detail.input, result, isError },
  );

  const status = isRunning
    ? "Loading skill…"
    : errorMessage
      ? "Failed to load"
      : tools.length > 0
        ? `Loaded · ${tools.length} tool${tools.length === 1 ? "" : "s"}`
        : "Loaded";

  const instructionLines = instructions ? instructions.split("\n").length : 0;

  return (
    <div className="flex flex-col gap-5">
      <SkillIdentity skillId={skillId} status={status} />

      {errorMessage && (
        <div className="rounded-lg border border-[var(--system-negative-strong)] bg-[var(--system-negative-weak)] p-3">
          <Typography
            variant="body-small-default"
            as="p"
            className="whitespace-pre-wrap break-words text-[var(--content-default)]"
          >
            {errorMessage}
          </Typography>
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <SectionLabel>Provides</SectionLabel>
          <SkillToolList tools={tools} />
        </div>
      )}

      {instructions && (
        <DetailDisclosure
          label="Instructions"
          hint={`${instructionLines} line${instructionLines === 1 ? "" : "s"}`}
          defaultOpen={instructions.length <= INSTRUCTIONS_AUTO_EXPAND_CHARS}
        >
          <ChatMarkdownMessage content={instructions} assistantId={assistantId} />
        </DetailDisclosure>
      )}

      {typeof result === "string" && result !== "" && (
        <DetailDisclosure label="Raw output">
          <CodeBlock text={result} />
        </DetailDisclosure>
      )}

      {isRunning && !instructions && !errorMessage && (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          Loading…
        </Typography>
      )}
    </div>
  );
}

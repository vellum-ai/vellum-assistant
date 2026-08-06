/**
 * Recent revisions for one skill, rendered as a collapsible list.
 *
 * One entry is one update to the whole skill, not one file: the daemon diffs a
 * commit against the skill's directory, so a change spanning `SKILL.md` and a
 * companion file arrives as a single revision with a combined diff. Entries are
 * shown newest first and collapsed by default, since the common question is
 * "when did this last change" and the diff is the follow-up.
 *
 * The list is bounded by workspace history compaction, so it is labelled as
 * recent changes and never presented as a complete record.
 */

import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { SkillsLoadingState } from "@/domains/intelligence/components/skills/skills-loading-state";
import {
  parseUnifiedDiff,
  type DiffRow,
} from "@/domains/intelligence/skills/parse-unified-diff";
import { useSkillHistory, type SkillRevision } from "@/hooks/use-skill-history";
import { formatFullLocalDate, formatRelativeDate } from "@/utils/format-date";
import { Collapsible } from "@vellumai/design-library";

export function SkillRevisionHistory({
  assistantId,
  skillId,
}: {
  assistantId: string;
  skillId: string;
}) {
  const { revisions, truncatedByCompaction, isLoading, isError } =
    useSkillHistory(assistantId, skillId);

  if (isLoading) {
    return <SkillsLoadingState />;
  }

  if (isError) {
    return <EmptyNote>Couldn&apos;t load revision history.</EmptyNote>;
  }

  return (
    <SkillRevisionList
      skillId={skillId}
      revisions={revisions}
      truncatedByCompaction={truncatedByCompaction}
    />
  );
}

/**
 * The rendered list, separated from the query so it can be exercised directly
 * with fixture revisions.
 */
export function SkillRevisionList({
  skillId,
  revisions,
  truncatedByCompaction,
}: {
  skillId: string;
  revisions: SkillRevision[];
  truncatedByCompaction: boolean;
}) {
  if (revisions.length === 0) {
    return <EmptyNote>No changes recorded yet.</EmptyNote>;
  }

  return (
    <Collapsible.Root type="multiple" className="flex flex-col gap-2 p-3">
      {revisions.map((revision) => (
        <RevisionRow key={revision.id} revision={revision} skillId={skillId} />
      ))}
      {truncatedByCompaction && (
        <p
          className="px-1 pt-1 text-body-small-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          Showing recent changes. Older history is periodically compacted, so
          this may not reach back to when the skill was created.
        </p>
      )}
    </Collapsible.Root>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="px-3 py-10 text-center text-body-medium-lighter"
      style={{ color: "var(--content-tertiary)" }}
    >
      {children}
    </p>
  );
}

function RevisionRow({
  revision,
  skillId,
}: {
  revision: SkillRevision;
  skillId: string;
}) {
  // Parsing walks the whole diff, and the collapsed row needs it only for the
  // +/- counts, so keep it off the render path for a list that may hold 20.
  const parsed = useMemo(
    () => parseUnifiedDiff(revision.diff, skillId),
    [revision.diff, skillId],
  );

  return (
    <Collapsible.Item
      value={revision.id}
      className="overflow-hidden rounded-md border"
      style={{ borderColor: "var(--border-base)" }}
    >
      <Collapsible.Trigger className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]">
        <ChevronRight
          className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {formatRelativeDate(revision.changedAt)}
          </span>
          <span
            className="mt-0.5 block truncate text-body-small-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {revision.files.join(" · ")}
          </span>
        </span>
        {parsed.added > 0 && (
          <span
            className="shrink-0 text-body-small-default tabular-nums"
            style={{ color: "var(--system-positive-strong)" }}
          >
            +{parsed.added}
          </span>
        )}
        {parsed.removed > 0 && (
          <span
            className="shrink-0 text-body-small-default tabular-nums"
            style={{ color: "var(--system-negative-strong)" }}
          >
            &minus;{parsed.removed}
          </span>
        )}
      </Collapsible.Trigger>

      <Collapsible.Content
        className="border-t"
        style={{ borderColor: "var(--border-base)" }}
      >
        <p
          className="px-3 py-2 text-body-small-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {formatFullLocalDate(revision.changedAt)}
        </p>
        {parsed.files.length === 0 ? (
          <p
            className="px-3 pb-3 text-body-small-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            No preview available for this change.
          </p>
        ) : (
          parsed.files.map((file) => (
            <div key={file.path}>
              <p
                className="border-t px-3 py-1.5 font-mono text-body-small-default"
                style={{
                  borderColor: "var(--border-base)",
                  backgroundColor: "var(--surface-base)",
                  color: "var(--content-secondary)",
                }}
              >
                {file.path}
              </p>
              <div className="overflow-x-auto py-1 font-mono text-body-small-lighter">
                {file.rows.map((row, index) => (
                  <DiffLine key={index} row={row} />
                ))}
              </div>
            </div>
          ))
        )}
      </Collapsible.Content>
    </Collapsible.Item>
  );
}

/**
 * Mirrors the gutter layout of the chat file-diff view so a diff reads the same
 * wherever it appears. That component computes its diff from two texts and
 * keeps its row renderer private, so there is nothing to import here.
 */
function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === "meta") {
    return (
      <div
        className="px-3 py-0.5"
        style={{ color: "var(--content-faint)" }}
        aria-hidden
      >
        ⋯
      </div>
    );
  }

  const isAdd = row.type === "add";
  const isDel = row.type === "del";

  return (
    <div
      className="flex whitespace-pre"
      style={{
        backgroundColor: isAdd
          ? "var(--system-positive-weak)"
          : isDel
            ? "var(--system-negative-weak)"
            : undefined,
        color: isAdd
          ? "var(--system-positive-strong)"
          : isDel
            ? "var(--system-negative-strong)"
            : "var(--content-secondary)",
      }}
    >
      <span
        className="w-10 shrink-0 pr-2 text-right tabular-nums"
        style={{ color: "var(--content-faint)" }}
      >
        {row.oldNo ?? ""}
      </span>
      <span
        className="w-10 shrink-0 pr-2 text-right tabular-nums"
        style={{ color: "var(--content-faint)" }}
      >
        {row.newNo ?? ""}
      </span>
      <span className="w-4 shrink-0 text-center">
        {isAdd ? "+" : isDel ? "-" : " "}
      </span>
      <span className="flex-1 pr-3">{row.text}</span>
    </div>
  );
}

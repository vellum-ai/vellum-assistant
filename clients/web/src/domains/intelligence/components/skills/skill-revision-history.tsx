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

import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  parseUnifiedDiff,
  type DiffRow,
} from "@/domains/intelligence/skills/parse-unified-diff";
import { useSkillHistory, type SkillRevision } from "@/hooks/use-skill-history";
import { cn } from "@/utils/misc";

/** Absolute date, since a revision is a point in time worth citing exactly. */
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 days ago" for a recent change, falling back to nothing for anything the
 * absolute date already communicates better.
 */
function formatRelative(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return null;
  }
  const elapsed = now - then;
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return RELATIVE_FORMAT.format(-Math.floor(elapsed / MINUTE), "minute");
  }
  if (elapsed < DAY) {
    return RELATIVE_FORMAT.format(-Math.floor(elapsed / HOUR), "hour");
  }
  if (elapsed < 30 * DAY) {
    return RELATIVE_FORMAT.format(-Math.floor(elapsed / DAY), "day");
  }
  return null;
}

function formatAbsolute(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : DATE_FORMAT.format(parsed);
}

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
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2
          className="h-5 w-5 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (isError) {
    return (
      <p
        className="px-3 py-10 text-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        Couldn&apos;t load revision history.
      </p>
    );
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
  // Read the clock once per mount rather than on each render: "2 days ago"
  // only needs to be right when the list is opened, and a bare `Date.now()`
  // in the render body is an impure call.
  const [now] = useState(() => Date.now());

  if (revisions.length === 0) {
    return (
      <p
        className="px-3 py-10 text-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        No changes recorded yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {revisions.map((revision) => (
        <RevisionRow
          key={revision.id}
          revision={revision}
          skillId={skillId}
          now={now}
        />
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
    </div>
  );
}

function RevisionRow({
  revision,
  skillId,
  now,
}: {
  revision: SkillRevision;
  skillId: string;
  now: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const parsed = parseUnifiedDiff(revision.diff, skillId);
  const relative = formatRelative(revision.changedAt, now);

  return (
    <div
      className="overflow-hidden rounded-md border"
      style={{ borderColor: "var(--border-base)" }}
    >
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {relative ?? formatAbsolute(revision.changedAt)}
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
      </button>

      {isOpen && (
        <div className="border-t" style={{ borderColor: "var(--border-base)" }}>
          <p
            className="px-3 py-2 text-body-small-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {formatAbsolute(revision.changedAt)}
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
        </div>
      )}
    </div>
  );
}

/**
 * One diff line: two line-number gutters, a marker column, then the text.
 * Mirrors the gutter layout the chat file-diff view already uses so a diff
 * reads the same wherever it appears in the app.
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

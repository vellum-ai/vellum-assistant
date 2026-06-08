import { type ReactNode } from "react";

import { Card } from "@vellumai/design-library";

import {
    aggregateSkillLoads,
    type SkillLoad,
} from "@/domains/chat/inspector/skill-load-aggregator";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";

interface SkillsTabProps {
  logs: LLMRequestLogEntry[];
  buildCallHref: (logId: string) => string;
}

/**
 * Skills tab — conversation-wide rollup of every `skill_load` invocation
 * captured across all LLM calls in the conversation.
 *
 * Each loaded skill is listed once with a per-call breakdown (Call N ·
 * timestamp), linking back to the specific LLM call where the load
 * happened. Answers the question "did skill X get loaded?" at a glance
 * without having to scan every Prompt/Response tab.
 *
 * Aggregation logic lives in `skill-load-aggregator.ts` so it can be
 * unit-tested without pulling in React / design-library.
 */
export function SkillsTab({ logs, buildCallHref }: SkillsTabProps): ReactNode {
  const grouped = aggregateSkillLoads(logs);
  const totalLoads = grouped.reduce((sum, g) => sum + g.loads.length, 0);
  const uniqueCount = grouped.length;

  if (uniqueCount === 0) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Card>
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            No skills were loaded in this conversation
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            This tab lists every <code>skill_load</code> tool call across the
            conversation. None were detected in the captured LLM calls.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Skills loaded in this conversation
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {uniqueCount === 1 ? "1 unique skill" : `${uniqueCount} unique skills`}
          {" · "}
          {totalLoads === 1 ? "1 load call" : `${totalLoads} load calls`}
        </p>
      </Card>

      {grouped.map((entry) => (
        <SkillCard
          key={entry.skill}
          skill={entry.skill}
          loads={entry.loads}
          buildCallHref={buildCallHref}
        />
      ))}
    </div>
  );
}

interface SkillCardProps {
  skill: string;
  loads: SkillLoad[];
  buildCallHref: (logId: string) => string;
}

function SkillCard({
  skill,
  loads,
  buildCallHref,
}: SkillCardProps): ReactNode {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {skill}
        </span>
        <span
          className="text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {loads.length === 1 ? "1 load" : `${loads.length} loads`}
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {loads.map((load) => (
          <li key={`${load.logId}-${load.sectionIndex}`}>
            <a
              href={buildCallHref(load.logId)}
              className="inline-flex items-baseline gap-2 rounded px-2 py-1 text-label-default hover:bg-[var(--surface-overlay)]"
              style={{ color: "var(--content-default)" }}
            >
              <span style={{ color: "var(--content-secondary)" }}>
                Call {load.callNumber}
              </span>
              <span style={{ color: "var(--content-tertiary)" }}>·</span>
              <span style={{ color: "var(--content-tertiary)" }}>
                {formatTimestamp(load.createdAt)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function formatTimestamp(createdAt: number): string {
  if (!Number.isFinite(createdAt)) return "—";
  return dateTimeFormatter.format(new Date(createdAt));
}

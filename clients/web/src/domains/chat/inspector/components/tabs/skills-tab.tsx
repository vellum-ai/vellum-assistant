import { type ReactNode } from "react";

import { Card } from "@vellumai/design-library";

import {
  aggregateSkillLoads,
  type SkillLoad,
} from "@/domains/chat/inspector/skill-load-aggregator";
import { Trans, useTranslation } from "@/i18n";
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
  const { t } = useTranslation("chat");
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
            {t("skillsTab.emptyTitle")}
          </p>
          <p
            className="mt-1 text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            <Trans
              ns="chat"
              i18nKey="skillsTab.emptyBody"
              components={{ code: <code /> }}
            />
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
          {t("skillsTab.summaryTitle")}
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {t("skillsTab.summaryStats", { uniqueCount, totalLoads })}
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

function SkillCard({ skill, loads, buildCallHref }: SkillCardProps): ReactNode {
  const { t } = useTranslation("chat");

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
          {t("skillsTab.loadCount", { count: loads.length })}
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
                {t("skillsTab.callLink", { number: load.callNumber })}
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
  if (!Number.isFinite(createdAt)) {
    return "—";
  }
  return dateTimeFormatter.format(new Date(createdAt));
}

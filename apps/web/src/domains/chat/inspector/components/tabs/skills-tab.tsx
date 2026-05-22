import { type ReactNode } from "react";

import { Card } from "@vellum/design-library";

import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@/domains/chat/types/inspector-types.js";

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
 * Data source: walks `entry.responseSections` for every log and picks
 * out sections where the kind is a provider tool-use block (`tool_use`
 * for Anthropic, `function_call` for OpenAI Responses) and the tool
 * name is `skill_load`. The skill id is read from the normalized
 * `data.skill` payload that the daemon emits in
 * `assistant/src/runtime/routes/llm-context-normalization.ts`.
 */
export function SkillsTab({ logs, buildCallHref }: SkillsTabProps): ReactNode {
  const loads = collectSkillLoads(logs);

  if (loads.length === 0) {
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

  const grouped = groupBySkill(loads);
  const totalLoads = loads.length;
  const uniqueCount = grouped.length;

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

// ─── aggregation ─────────────────────────────────────────────────────────────

interface SkillLoad {
  skill: string;
  logId: string;
  createdAt: number;
  callNumber: number;
  sectionIndex: number;
}

interface SkillGroup {
  skill: string;
  loads: SkillLoad[];
}

/**
 * Tool-use kinds that the daemon's normalizer emits for assistant tool
 * calls. `tool_use` covers Anthropic Messages, `function_call` covers
 * OpenAI Responses. Kept in lowercase for case-insensitive matching.
 */
const TOOL_USE_KINDS = new Set(["tool_use", "function_call"]);

function collectSkillLoads(logs: LLMRequestLogEntry[]): SkillLoad[] {
  const loads: SkillLoad[] = [];
  // Call numbers track chronological order — Call 1 is the first LLM
  // call recorded for the conversation, matching the labeling used in
  // the call rail.
  const ordered = [...logs].sort((a, b) => a.createdAt - b.createdAt);
  ordered.forEach((entry, callIndex) => {
    const sections = entry.responseSections ?? [];
    sections.forEach((section, sectionIndex) => {
      const skill = extractSkillId(section);
      if (skill == null) return;
      loads.push({
        skill,
        logId: entry.id,
        createdAt: entry.createdAt,
        callNumber: callIndex + 1,
        sectionIndex,
      });
    });
  });
  return loads;
}

function extractSkillId(section: LLMContextSection): string | null {
  const kind = section.kind?.toLowerCase?.() ?? "";
  if (!TOOL_USE_KINDS.has(kind)) return null;
  if (section.toolName !== "skill_load") return null;
  const data = section.data;
  if (data == null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>).skill;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function groupBySkill(loads: SkillLoad[]): SkillGroup[] {
  const map = new Map<string, SkillLoad[]>();
  for (const load of loads) {
    const existing = map.get(load.skill);
    if (existing) {
      existing.push(load);
    } else {
      map.set(load.skill, [load]);
    }
  }
  // Sort groups by first-load timestamp ascending — chronological
  // "what got pulled in over time" reads well for debugging.
  return Array.from(map.entries())
    .map(([skill, groupLoads]) => ({ skill, loads: groupLoads }))
    .sort((a, b) => a.loads[0]!.createdAt - b.loads[0]!.createdAt);
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

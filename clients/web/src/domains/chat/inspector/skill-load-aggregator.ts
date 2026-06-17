/**
 * Pure aggregator that walks the inspector's per-call response sections
 * and groups every `skill_load` tool invocation by skill id. Lives
 * outside the component file so unit tests can import it without
 * pulling in React / design-library.
 *
 * Data source: the daemon's normalizer (`assistant/src/runtime/routes/
 * llm-context-normalization.ts`) emits one `tool_use` section
 * (Anthropic Messages) or `function_call` section (OpenAI Responses)
 * per assistant tool call, with `toolName` set to the tool name and
 * `data` set to the parsed input record. For `skill_load`, the skill
 * id lives in `data.skill`.
 */

import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";

export interface SkillLoad {
  skill: string;
  logId: string;
  createdAt: number;
  callNumber: number;
  sectionIndex: number;
}

export interface SkillGroup {
  skill: string;
  loads: SkillLoad[];
}

/**
 * Tool-use kinds emitted by the daemon's normalizer for assistant tool
 * calls. `tool_use` is the Anthropic Messages shape and
 * `function_call` is the OpenAI Responses shape.
 */
const TOOL_USE_KINDS = new Set(["tool_use", "function_call"]);

/**
 * Walk every log's response sections, find every `skill_load`
 * invocation, and return one `SkillGroup` per unique skill id —
 * sorted by first appearance.
 */
export function aggregateSkillLoads(logs: LLMRequestLogEntry[]): SkillGroup[] {
  const loads = collectSkillLoads(logs);
  return groupBySkill(loads);
}

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

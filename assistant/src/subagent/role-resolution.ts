/**
 * Resolution of the `role` a spawn asks for into one of the three subagent
 * types.
 *
 * The model writes this field freely: it names a type, an older type name, a
 * job title, or a whole sentence of framing. Every one of those has to land on
 * a defined capability envelope, so resolution is total and never rejects.
 */

import { truncate } from "../util/truncate.js";
import {
  DEFAULT_SUBAGENT_ROLE,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentRole,
} from "./types.js";

export interface ResolvedSubagentRole {
  /** The type the child actually runs as. */
  role: SubagentRole;
  /**
   * The requested text, when it named no type and is carried into the child's
   * framing as a persona instead.
   */
  personaText?: string;
  /** The legacy name the caller used, when it resolved through an alias. */
  alias?: string;
}

/**
 * The role names that predate the three types. They stay accepted because
 * every prompt, skill, and habit that names one is still in circulation, and a
 * spawn is a poor place to learn a taxonomy changed.
 */
const ROLE_ALIASES: Record<string, SubagentRole> = {
  planner: "researcher",
  investigator: "researcher",
  coder: "builder",
  general: "builder",
};

/**
 * How much of a free-text role survives into the persona line. A role value
 * can arrive as an entire sentence of instructions; the persona line is a
 * framing hint, and the objective is where the task belongs.
 */
const MAX_PERSONA_LENGTH = 120;

/** Single-line, length-bounded form of a free-text role. */
function toPersonaText(raw: string): string {
  return truncate(raw.replace(/\s+/g, " ").trim(), MAX_PERSONA_LENGTH);
}

/**
 * Resolve a requested role into the type the child runs as.
 *
 * - Absent (or blank) resolves to `builder`, which imposes no tool allowlist.
 *   A spawn that names no role has always run on the parent's full surface,
 *   and a task delegated without a stated shape is as likely to need a file
 *   written as read.
 * - The three type names pass through, case-insensitively.
 * - A legacy name resolves to its successor type and is reported in `alias`.
 * - Anything else resolves to `researcher` with the text kept as
 *   `personaText`. This is least privilege for a value nobody defined: a typo
 *   or an invented role must not silently hand out write access. When the task
 *   really did need to write, the child reports that it cannot and the parent
 *   re-spawns as `builder`, which is a visible and cheap correction.
 */
export function resolveSubagentRole(
  raw: string | undefined,
): ResolvedSubagentRole {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return { role: DEFAULT_SUBAGENT_ROLE };
  }

  // `Object.hasOwn` rather than `in`: a role of "constructor" or "toString"
  // reaches inherited members and would resolve to something that is not a
  // role at all.
  const key = trimmed.toLowerCase();
  if (Object.hasOwn(SUBAGENT_ROLE_REGISTRY, key)) {
    return { role: key as SubagentRole };
  }
  if (Object.hasOwn(ROLE_ALIASES, key)) {
    return { role: ROLE_ALIASES[key], alias: key };
  }

  return { role: "researcher", personaText: toPersonaText(trimmed) };
}

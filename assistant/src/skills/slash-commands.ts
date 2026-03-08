import type { ResolvedSkill } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";

/**
 * Parse whether user input starts with a slash-like command token.
 *
 * Rules:
 * - Trim leading whitespace.
 * - Only inspect the first whitespace-delimited token.
 * - A candidate token must begin with `/`.
 * - Return `none` for empty input.
 */

export function extractLeadingToken(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s/)[0];
  return firstToken || null;
}

export function parseSlashCandidate(input: string): {
  kind: "none" | "candidate";
  token?: string;
} {
  const token = extractLeadingToken(input);
  if (!token || !token.startsWith("/")) {
    return { kind: "none" };
  }
  if (isPathLikeSlashToken(token)) {
    return { kind: "none" };
  }
  const id = token.slice(1);
  if (!isValidSlashSkillId(id)) {
    return { kind: "none" };
  }
  return { kind: "candidate", token };
}

/** Validate that a slash skill ID starts with alphanumeric and contains only [A-Za-z0-9._-] */
export function isValidSlashSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** Detect filesystem-like paths: tokens containing more than one `/` */
export function isPathLikeSlashToken(token: string): boolean {
  // Count slashes — a single leading `/` is expected, but any additional `/` means it's a path
  const slashCount = token.split("/").length - 1;
  return slashCount > 1;
}

// ─── Invocable slash skill catalog ──────────────────────────────────────────

export interface InvocableSlashSkill {
  canonicalId: string;
  name: string;
  summary: SkillSummary;
}

/**
 * Build a map of slash-invocable skills keyed by lowercase ID for
 * case-insensitive lookup. Only includes skills that are `userInvocable`
 * and whose resolved state is not `disabled`.
 */
export function buildInvocableSlashCatalog(
  catalog: SkillSummary[],
  resolvedStates: ResolvedSkill[],
): Map<string, InvocableSlashSkill> {
  const stateById = new Map<string, ResolvedSkill>();
  for (const rs of resolvedStates) {
    stateById.set(rs.summary.id, rs);
  }

  const result = new Map<string, InvocableSlashSkill>();
  for (const skill of catalog) {
    if (!skill.userInvocable) continue;
    const resolved = stateById.get(skill.id);
    if (!resolved || resolved.state === "disabled") continue;
    result.set(skill.id.toLowerCase(), {
      canonicalId: skill.id,
      name: skill.displayName,
      summary: skill,
    });
  }
  return result;
}

// ─── Slash command resolution ────────────────────────────────────────────────

export type SlashResolution =
  | { kind: "none" }
  | { kind: "known"; skillId: string; trailingArgs: string }
  | { kind: "unknown"; requestedId: string; message: string };

/**
 * Resolve user input against the invocable slash catalog.
 *
 * Returns:
 * - `none` if input is not a slash candidate (normal text, path, etc.)
 * - `known` if the slash ID matches an invocable skill (case-insensitive)
 * - `unknown` if it's a valid slash candidate but no matching skill exists
 */
export function resolveSlashSkillCommand(
  input: string,
  catalog: Map<string, InvocableSlashSkill>,
): SlashResolution {
  const candidate = parseSlashCandidate(input);
  if (candidate.kind === "none") {
    return { kind: "none" };
  }

  const token = candidate.token!;
  const requestedId = token.slice(1);
  const lookupKey = requestedId.toLowerCase();

  // Extract trailing args: everything after the first token
  const trimmed = input.trimStart();
  const firstSpaceIdx = trimmed.search(/\s/);
  const trailingArgs =
    firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx).trim();

  const match = catalog.get(lookupKey);
  if (match) {
    return { kind: "known", skillId: match.canonicalId, trailingArgs };
  }

  const availableIds = Array.from(catalog.values())
    .map((s) => s.canonicalId)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return {
    kind: "unknown",
    requestedId,
    message: formatUnknownSlashSkillMessage(requestedId, availableIds),
  };
}

/**
 * Build a deterministic error message for an unknown slash command.
 */
export function formatUnknownSlashSkillMessage(
  requestedId: string,
  availableSkillIds: string[],
): string {
  const lines = [`Unknown command \`/${requestedId}\`.`];
  if (availableSkillIds.length > 0) {
    lines.push("");
    lines.push("Available slash commands:");
    for (const id of availableSkillIds) {
      lines.push(`- \`/${id}\``);
    }
  } else {
    lines.push("");
    lines.push("No slash commands are currently available.");
  }
  return lines.join("\n");
}

// ─── Prompt rewrite for known slash commands ─────────────────────────────────

/**
 * Rewrite user input for a known slash command into a model-facing prompt
 * that explicitly instructs the model to invoke the skill.
 *
 * For the claude-code skill, trailing arguments are routed via the `command`
 * input (not `prompt`) so that .claude/commands/*.md templates are loaded
 * and $ARGUMENTS substitution is applied.
 */
export function rewriteKnownSlashCommandPrompt(params: {
  rawInput: string;
  skillId: string;
  skillName: string;
  trailingArgs: string;
}): string {
  // For the claude-code skill, route trailing args through the `command` input
  // so CC command templates (.claude/commands/*.md) are loaded and $ARGUMENTS
  // substitution is applied, rather than sending them as a raw prompt.
  if (params.skillId === "claude-code" && params.trailingArgs) {
    // Extract the command name (first word of trailing args) and remaining arguments
    const parts = params.trailingArgs.split(/\s+/);
    const commandName = parts[0];
    const commandArgs = parts.slice(1).join(" ");

    const lines = [
      `The user invoked the slash command \`/${params.skillId}\`.`,
      `Execute the Claude Code command "${commandName}" using the claude_code tool with command="${commandName}".`,
    ];
    if (commandArgs) {
      lines.push(
        `Pass the following as the \`arguments\` input: ${commandArgs}`,
      );
    }
    return lines.join("\n");
  }

  const lines = [
    `The user invoked the slash command \`/${params.skillId}\`.`,
    `Please invoke the "${params.skillName}" skill (ID: ${params.skillId}).`,
  ];
  if (params.trailingArgs) {
    lines.push("");
    lines.push(`User arguments: ${params.trailingArgs}`);
  }
  return lines.join("\n");
}

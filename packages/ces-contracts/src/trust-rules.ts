/**
 * Trust rule types shared between the assistant daemon and the gateway.
 *
 * These are extracted from `assistant/src/permissions/types.ts` and
 * `assistant/src/permissions/trust-store.ts` so that both packages can
 * reference a single canonical definition.
 *
 * Tools are grouped into "families" based on how their permission candidates
 * are constructed and matched:
 *
 * - **Scoped**: tools whose candidates include a filesystem path and obey
 *   directory-boundary scope constraints (`file_read`, `file_write`,
 *   `file_edit`, `host_file_read`, `host_file_write`, `host_file_edit`,
 *   `bash`, `host_bash`).
 * - **URL**: tools whose candidates include a URL (`web_fetch`,
 *   `browser_navigate`, `network_request`).
 * - **Managed skill**: tools that manage first-party skill packages
 *   (`scaffold_managed_skill`, `delete_managed_skill`).
 * - **Skill load**: the `skill_load` tool, which uses a distinct candidate
 *   namespace (`skill_load:selector` or `skill_load_dynamic:selector`).
 * - **Generic**: everything else (computer-use tools, browser action tools,
 *   UI surface tools, recall, skill_execute, etc.).
 */

// ---------------------------------------------------------------------------
// Trust decision
// ---------------------------------------------------------------------------

/** The possible decisions a trust rule can make. */
export type TrustDecision = "allow" | "deny" | "ask";

// ---------------------------------------------------------------------------
// Tool family constants
// ---------------------------------------------------------------------------

/**
 * Tools whose permission candidates are scoped to a filesystem path and obey
 * directory-boundary scope constraints.
 */
export const SCOPED_TOOLS = [
  "file_read",
  "file_write",
  "file_edit",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "bash",
  "host_bash",
] as const;

/**
 * Tools whose permission candidates include a URL.
 */
export const URL_TOOLS = [
  "web_fetch",
  "browser_navigate",
  "network_request",
] as const;

/**
 * Tools that manage first-party skill packages (scaffold/delete).
 */
export const MANAGED_SKILL_TOOLS = [
  "scaffold_managed_skill",
  "delete_managed_skill",
] as const;

/**
 * The skill_load tool name. Separated from the array constants because
 * skill_load is a singleton, not a family with multiple members.
 */
export const SKILL_LOAD_TOOL = "skill_load" as const;

/** Set for O(1) lookups when classifying tool names. */
const SCOPED_TOOLS_SET: ReadonlySet<string> = new Set(SCOPED_TOOLS);
const URL_TOOLS_SET: ReadonlySet<string> = new Set(URL_TOOLS);
const MANAGED_SKILL_TOOLS_SET: ReadonlySet<string> = new Set(
  MANAGED_SKILL_TOOLS,
);

// ---------------------------------------------------------------------------
// Trust rule — base and family-specific variants
// ---------------------------------------------------------------------------

/** Fields shared by all trust rule variants. */
export interface TrustRuleBase {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: TrustDecision;
  priority: number;
  createdAt: number;
}

/**
 * A trust rule for a scoped tool (filesystem-path-based candidates).
 *
 * Scoped rules may carry `executionTarget` to constrain matching to a
 * specific execution environment and `allowHighRisk` to permit high-risk
 * operations under the rule's allow decision.
 */
export interface ScopedTrustRule extends TrustRuleBase {
  tool: (typeof SCOPED_TOOLS)[number];
  executionTarget?: string;
  allowHighRisk?: boolean;
}

/**
 * A trust rule for a URL-based tool.
 *
 * URL rules do not use `executionTarget` or `allowHighRisk` — those
 * semantics are specific to scoped (filesystem/shell) tools.
 */
export interface UrlTrustRule extends TrustRuleBase {
  tool: (typeof URL_TOOLS)[number];
}

/**
 * A trust rule for a managed-skill tool (scaffold/delete).
 */
export interface ManagedSkillTrustRule extends TrustRuleBase {
  tool: (typeof MANAGED_SKILL_TOOLS)[number];
}

/**
 * A trust rule for the `skill_load` tool.
 */
export interface SkillLoadTrustRule extends TrustRuleBase {
  tool: typeof SKILL_LOAD_TOOL;
}

/**
 * A trust rule for any tool that doesn't belong to a known family.
 *
 * Generic rules preserve `executionTarget` and `allowHighRisk` for backward
 * compatibility — existing rules for unknown/new tools may carry these fields.
 */
export interface GenericTrustRule extends TrustRuleBase {
  tool: string;
  executionTarget?: string;
  allowHighRisk?: boolean;
}

/**
 * Discriminated union of all trust rule families.
 *
 * The union is discriminated on the `tool` field: known tool names narrow to
 * the corresponding family variant, while unknown tool names fall through to
 * `GenericTrustRule`.
 *
 * For backward compatibility, `TrustRule` remains the single type that all
 * existing code uses. The family-specific interfaces exist so that new code
 * can narrow the type when it knows the tool family.
 */
export type TrustRule =
  | ScopedTrustRule
  | UrlTrustRule
  | ManagedSkillTrustRule
  | SkillLoadTrustRule
  | GenericTrustRule;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Narrow a TrustRule to a ScopedTrustRule. */
export function isScopedRule(rule: TrustRule): rule is ScopedTrustRule {
  return SCOPED_TOOLS_SET.has(rule.tool);
}

/** Narrow a TrustRule to a UrlTrustRule. */
export function isUrlRule(rule: TrustRule): rule is UrlTrustRule {
  return URL_TOOLS_SET.has(rule.tool);
}

/** Narrow a TrustRule to a ManagedSkillTrustRule. */
export function isManagedSkillRule(
  rule: TrustRule,
): rule is ManagedSkillTrustRule {
  return MANAGED_SKILL_TOOLS_SET.has(rule.tool);
}

/** Narrow a TrustRule to a SkillLoadTrustRule. */
export function isSkillLoadRule(rule: TrustRule): rule is SkillLoadTrustRule {
  return rule.tool === SKILL_LOAD_TOOL;
}

// ---------------------------------------------------------------------------
// Canonical parse / normalize
// ---------------------------------------------------------------------------

/**
 * Result of parsing a raw trust rule object. Includes the normalized rule
 * and a flag indicating whether any normalization occurred (so callers can
 * trigger a re-save of the trust file).
 */
export interface ParsedTrustRule {
  rule: TrustRule;
  /** True if any fields were stripped or modified during normalization. */
  normalized: boolean;
}

/**
 * Parse and normalize a raw trust rule object into a canonical `TrustRule`.
 *
 * Normalization strips fields that are invalid for the rule's tool family:
 * - URL rules: `executionTarget` and `allowHighRisk` are stripped (URL tools
 *   don't support these semantics).
 * - Managed skill rules: `executionTarget` and `allowHighRisk` are stripped.
 * - Skill load rules: `executionTarget` and `allowHighRisk` are stripped.
 * - Scoped rules and generic rules: all fields are preserved.
 *
 * Unknown tools (generic family) preserve all fields for forward compatibility
 * — we don't know what semantics future tools may require.
 */
export function parseTrustRule(raw: Record<string, unknown>): ParsedTrustRule {
  let normalized = false;

  // Extract base fields with coercion for safety — mark normalized whenever
  // a field is coerced to its default so callers know to re-save.
  const id = typeof raw.id === "string" ? raw.id : ((normalized = true), "");
  const tool =
    typeof raw.tool === "string" ? raw.tool : ((normalized = true), "");
  const pattern =
    typeof raw.pattern === "string" ? raw.pattern : ((normalized = true), "");
  const scope =
    typeof raw.scope === "string"
      ? raw.scope
      : ((normalized = true), "everywhere");
  const decision = isValidDecision(raw.decision)
    ? raw.decision
    : ((normalized = true), "ask" as const);
  const priority =
    typeof raw.priority === "number" ? raw.priority : ((normalized = true), 100);
  const createdAt =
    typeof raw.createdAt === "number"
      ? raw.createdAt
      : ((normalized = true), 0);

  // Build the base rule
  const base: TrustRuleBase = {
    id,
    tool,
    pattern,
    scope,
    decision,
    priority,
    createdAt,
  };

  // Determine the family and strip invalid fields
  if (URL_TOOLS_SET.has(tool)) {
    // URL rules must not carry executionTarget or allowHighRisk
    if (raw.executionTarget !== undefined || raw.allowHighRisk !== undefined) {
      normalized = true;
    }
    const rule: UrlTrustRule = { ...base, tool: tool as UrlTrustRule["tool"] };
    return { rule, normalized };
  }

  if (MANAGED_SKILL_TOOLS_SET.has(tool)) {
    // Managed skill rules must not carry executionTarget or allowHighRisk
    if (raw.executionTarget !== undefined || raw.allowHighRisk !== undefined) {
      normalized = true;
    }
    const rule: ManagedSkillTrustRule = {
      ...base,
      tool: tool as ManagedSkillTrustRule["tool"],
    };
    return { rule, normalized };
  }

  if (tool === SKILL_LOAD_TOOL) {
    // Skill load rules must not carry executionTarget or allowHighRisk
    if (raw.executionTarget !== undefined || raw.allowHighRisk !== undefined) {
      normalized = true;
    }
    const rule: SkillLoadTrustRule = { ...base, tool: SKILL_LOAD_TOOL };
    return { rule, normalized };
  }

  if (SCOPED_TOOLS_SET.has(tool)) {
    // Scoped rules preserve executionTarget and allowHighRisk
    const rule: ScopedTrustRule = {
      ...base,
      tool: tool as ScopedTrustRule["tool"],
    };
    if (
      typeof raw.executionTarget === "string" &&
      raw.executionTarget.length > 0
    ) {
      rule.executionTarget = raw.executionTarget;
    } else if (raw.executionTarget !== undefined) {
      normalized = true;
    }
    if (typeof raw.allowHighRisk === "boolean") {
      rule.allowHighRisk = raw.allowHighRisk;
    } else if (raw.allowHighRisk !== undefined) {
      normalized = true;
    }
    return { rule, normalized };
  }

  // Generic (unknown) tool — preserve all optional fields for forward compat
  const rule: GenericTrustRule = { ...base };
  if (
    typeof raw.executionTarget === "string" &&
    raw.executionTarget.length > 0
  ) {
    rule.executionTarget = raw.executionTarget;
  } else if (raw.executionTarget !== undefined) {
    normalized = true;
  }
  if (typeof raw.allowHighRisk === "boolean") {
    rule.allowHighRisk = raw.allowHighRisk;
  } else if (raw.allowHighRisk !== undefined) {
    normalized = true;
  }
  return { rule, normalized };
}

function isValidDecision(value: unknown): value is TrustDecision {
  return value === "allow" || value === "deny" || value === "ask";
}

// ---------------------------------------------------------------------------
// Trust file (on-disk shape)
// ---------------------------------------------------------------------------

/** Shape of the `trust.json` file persisted to disk. */
export interface TrustFileData {
  version: number;
  rules: TrustRule[];
  /** Set to true when the user explicitly accepts the starter approval bundle. */
  starterBundleAccepted?: boolean;
}

/**
 * Result of parsing a raw trust file. Includes the parsed data and a flag
 * indicating whether any rules were normalized.
 */
export interface ParsedTrustFileData {
  data: TrustFileData;
  /** True if any rules were normalized during parsing. */
  normalized: boolean;
}

/**
 * Parse and normalize a raw trust file object.
 *
 * Each rule in the `rules` array is run through `parseTrustRule` for
 * family-aware normalization. The `normalized` flag in the result is true
 * if *any* rule was modified, signaling the caller that a re-save is warranted.
 */
export function parseTrustFileData(
  raw: Record<string, unknown>,
): ParsedTrustFileData {
  const version = typeof raw.version === "number" ? raw.version : 0;
  const starterBundleAccepted =
    raw.starterBundleAccepted === true ? true : undefined;
  const rawRules = Array.isArray(raw.rules) ? raw.rules : [];

  let anyNormalized = false;
  const rules: TrustRule[] = [];

  for (const rawRule of rawRules) {
    if (rawRule == null || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      anyNormalized = true;
      continue;
    }
    const { rule, normalized } = parseTrustRule(
      rawRule as Record<string, unknown>,
    );
    if (normalized) anyNormalized = true;
    rules.push(rule);
  }

  const data: TrustFileData = { version, rules };
  if (starterBundleAccepted) {
    data.starterBundleAccepted = true;
  }

  return { data, normalized: anyNormalized };
}

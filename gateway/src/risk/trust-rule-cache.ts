import { TrustRuleStore, type TrustRule } from "../db/trust-rule-store.js";

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

class TrustRuleCache {
  private store: TrustRuleStore;
  /** Outer key = tool, inner key = pattern */
  private rules: Map<string, Map<string, TrustRule>> = new Map();

  constructor(store: TrustRuleStore) {
    this.store = store;
    this.refresh();
  }

  /**
   * Clear and reload all active rules from the store.
   */
  refresh(): void {
    this.rules.clear();
    const active = this.store.listActive();
    for (const rule of active) {
      let toolMap = this.rules.get(rule.tool);
      if (!toolMap) {
        toolMap = new Map();
        this.rules.set(rule.tool, toolMap);
      }
      toolMap.set(rule.pattern, rule);
    }
  }

  /**
   * Look up the base risk rule for a bash-style (tool, command) pair.
   *
   * Resolution order:
   * 1. Exact match on (tool, command)
   * 2. Path-stripped match: strip leading path prefix
   *    (e.g. `/usr/bin/rm` -> `rm`) and retry exact match
   * 3. Subcommand match: for multi-word commands (e.g. `git push`),
   *    try progressively shorter prefixes (`"git push"` then `"git"`)
   *
   * Each key is probed in both the literal and `action:`-prefixed dialect. The
   * rule editor persists generalized bash patterns with an `action:` prefix
   * (e.g. `action:git push`, produced by `scopeOptionsToAllowlistOptions`),
   * while the keys passed here are the bare action key the classifier resolves
   * from the command. Without the prefix-aware lookup, every generalized bash
   * trust rule created from any client (web, macOS, iOS, CLI) would silently
   * fail to match, since the save path and the matcher use different dialects.
   *
   * At a given key a user-authored rule (either dialect) wins over a seeded
   * registry default — otherwise a user-saved `action:git push` would be
   * shadowed by the seeded literal `git push` it was meant to override. The
   * most specific key still wins overall, so a more specific seeded default
   * (e.g. `git push`) is preserved over a broader user rule (e.g. `action:git`);
   * that broader rule still applies to subcommands without their own default.
   */
  findBaseRisk(tool: string, command: string): TrustRule | null {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return null;

    const isUserRule = (rule: TrustRule | undefined): rule is TrustRule =>
      !!rule && (rule.userModified || rule.origin === "user_defined");

    // At each key, prefer a user-authored rule (literal or `action:`) over a
    // seeded default; otherwise resolve the literal, then its `action:` sibling.
    const lookup = (key: string): TrustRule | undefined => {
      const literal = toolMap.get(key);
      const action = toolMap.get(`action:${key}`);
      if (isUserRule(literal)) return literal;
      if (isUserRule(action)) return action;
      return literal ?? action;
    };

    // 1. Exact match
    const exact = lookup(command);
    if (exact) return exact;

    // 2. Path-stripped match: /usr/bin/rm -> rm
    const stripped = this.stripPath(command);
    if (stripped !== command) {
      const strippedMatch = lookup(stripped);
      if (strippedMatch) return strippedMatch;
    }

    // 3. Subcommand match: try progressively shorter word prefixes
    // For "git push --force", try "git push --force", "git push", "git"
    const resolvedCommand = stripped !== command ? stripped : command;
    const parts = resolvedCommand.split(/\s+/);
    for (let i = parts.length - 1; i >= 1; i--) {
      const subcommand = parts.slice(0, i).join(" ");
      const match = lookup(subcommand);
      if (match) return match;
    }

    return null;
  }

  /**
   * Look up a tool override rule for a non-bash classifier (file, web, skill,
   * schedule).
   *
   * Matches the literal pattern first, then its `<tool>:`-prefixed form. The
   * rule editor's allowlist options for these tools carry a tool-name prefix
   * (e.g. `skill_load:my-skill`, `file_read:/path`, produced by the skill/file
   * classifiers' allowlist builders), and the web client — shared by iOS —
   * persists that pattern verbatim, while the classifier resolves the bare
   * selector (skill id, file path, URL). Without the prefix-aware fallback,
   * every such rule created from those clients would silently fail to match.
   * This mirrors the `action:`-prefix handling in {@link findBaseRisk}; the
   * macOS client and the seeded defaults persist bare patterns, which still
   * match on the first lookup.
   */
  findToolOverride(tool: string, pattern: string): TrustRule | null {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return null;
    return toolMap.get(pattern) ?? toolMap.get(`${tool}:${pattern}`) ?? null;
  }

  /**
   * Return all active rules for a given tool.
   */
  getAllForTool(tool: string): TrustRule[] {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return [];
    return Array.from(toolMap.values());
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Strip leading path components from a command.
   * `/usr/bin/rm` -> `rm`, `rm` -> `rm`
   */
  private stripPath(command: string): string {
    // Only strip path from the first token (the binary)
    const spaceIdx = command.indexOf(" ");
    const binary = spaceIdx === -1 ? command : command.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : command.slice(spaceIdx);

    const slashIdx = binary.lastIndexOf("/");
    if (slashIdx === -1) return command;

    return binary.slice(slashIdx + 1) + rest;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cache: TrustRuleCache | null = null;

export function initTrustRuleCache(store?: TrustRuleStore): void {
  cache = new TrustRuleCache(store ?? new TrustRuleStore());
}

export function getTrustRuleCache(): TrustRuleCache {
  if (!cache)
    throw new Error(
      "Risk rule cache not initialized \u2014 call initTrustRuleCache() at startup",
    );
  return cache;
}

export function invalidateTrustRuleCache(): void {
  cache?.refresh();
}

export function resetTrustRuleCache(): void {
  cache = null;
}

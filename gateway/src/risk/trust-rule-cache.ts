import {
  TrustRuleStore,
  type TrustRule,
} from "../db/trust-rule-store.js";

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
   */
  findBaseRisk(tool: string, command: string): TrustRule | null {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return null;

    // 1. Exact match
    const exact = toolMap.get(command);
    if (exact) return exact;

    // 2. Path-stripped match: /usr/bin/rm -> rm
    const stripped = this.stripPath(command);
    if (stripped !== command) {
      const strippedMatch = toolMap.get(stripped);
      if (strippedMatch) return strippedMatch;
    }

    // 3. Subcommand match: try progressively shorter word prefixes
    // For "git push --force", try "git push --force", "git push", "git"
    const resolvedCommand = stripped !== command ? stripped : command;
    const parts = resolvedCommand.split(/\s+/);
    for (let i = parts.length - 1; i >= 1; i--) {
      const subcommand = parts.slice(0, i).join(" ");
      const match = toolMap.get(subcommand);
      if (match) return match;
    }

    return null;
  }

  /**
   * Look up a tool override rule by exact (tool, pattern) match.
   * Used for non-bash classifiers (file, web, skill, schedule).
   */
  findToolOverride(tool: string, pattern: string): TrustRule | null {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return null;
    return toolMap.get(pattern) ?? null;
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

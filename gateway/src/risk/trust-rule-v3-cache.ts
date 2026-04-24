import {
  TrustRuleV3Store,
  type TrustRuleV3,
} from "../db/trust-rule-v3-store.js";

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

class TrustRuleV3Cache {
  private store: TrustRuleV3Store;
  /** Outer key = tool, inner key = pattern */
  private rules: Map<string, Map<string, TrustRuleV3>> = new Map();

  constructor(store: TrustRuleV3Store) {
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
  findBaseRisk(tool: string, command: string): TrustRuleV3 | null {
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
  findToolOverride(tool: string, pattern: string): TrustRuleV3 | null {
    const toolMap = this.rules.get(tool);
    if (!toolMap) return null;
    return toolMap.get(pattern) ?? null;
  }

  /**
   * Return all active rules for a given tool.
   */
  getAllForTool(tool: string): TrustRuleV3[] {
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

let cache: TrustRuleV3Cache | null = null;

export function initTrustRuleV3Cache(store?: TrustRuleV3Store): void {
  cache = new TrustRuleV3Cache(store ?? new TrustRuleV3Store());
}

export function getTrustRuleV3Cache(): TrustRuleV3Cache {
  if (!cache)
    throw new Error(
      "Risk rule cache not initialized \u2014 call initTrustRuleV3Cache() at startup",
    );
  return cache;
}

export function invalidateTrustRuleV3Cache(): void {
  cache?.refresh();
}

export function resetTrustRuleV3Cache(): void {
  cache = null;
}

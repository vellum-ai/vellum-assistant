/**
 * Action Playbook — a structured trigger→action rule that tells the
 * triage engine how to handle incoming messages matching a pattern.
 *
 * Playbooks are stored as memory_graph_nodes with
 * sourceConversations containing a "playbook:{nodeId}" entry. The
 * content column holds "Playbook: <trigger>\n<json>" where the JSON
 * encodes the structured fields below.
 */

export interface Playbook {
  /** Pattern or description that triggers this playbook (e.g. "meeting request", "from:ceo@*"). */
  trigger: string;
  /** Channel this rule applies to, or '*' for all channels. */
  channel: string;
  /** Free-form category for grouping (e.g. "scheduling", "triage", "notifications"). */
  category: string;
  /** What to do when the trigger matches — natural language action description. */
  action: string;
  /** How much autonomy the assistant has when executing this playbook. */
  autonomyLevel: PlaybookAutonomyLevel;
  /** Relative priority — higher numbers take precedence when multiple playbooks match. */
  priority: number;
}

export type PlaybookAutonomyLevel = "auto" | "draft" | "notify";

/**
 * Parse a playbook from its JSON-serialized statement column.
 * Returns null if the statement is not valid playbook JSON.
 */
export function parsePlaybookStatement(statement: string): Playbook | null {
  try {
    const parsed = JSON.parse(statement);
    if (
      typeof parsed.trigger !== "string" ||
      typeof parsed.action !== "string"
    ) {
      return null;
    }
    return {
      trigger: parsed.trigger,
      channel: typeof parsed.channel === "string" ? parsed.channel : "*",
      category:
        typeof parsed.category === "string" ? parsed.category : "general",
      action: parsed.action,
      autonomyLevel: isValidAutonomyLevel(parsed.autonomyLevel)
        ? parsed.autonomyLevel
        : "draft",
      priority: typeof parsed.priority === "number" ? parsed.priority : 0,
    };
  } catch {
    return null;
  }
}

function isValidAutonomyLevel(value: unknown): value is PlaybookAutonomyLevel {
  return value === "auto" || value === "draft" || value === "notify";
}

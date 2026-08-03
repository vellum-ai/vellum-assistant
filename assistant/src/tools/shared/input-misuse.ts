/**
 * Targeted guidance for tool calls whose parameter names reveal that the
 * caller wanted a different tool, or a different spelling of a parameter this
 * tool does accept.
 *
 * `validateInputAgainstSchema` rejects any key a tool's `TOOLS.json`
 * `properties` block does not declare, and its generic `Unknown parameter
 * "path". Supported: ...` error lists the accepted keys without naming the
 * tool the caller actually wants. A tool listed here replaces that error with
 * a redirect the caller can act on in a single retry. Declaring these keys in
 * `properties` instead would advertise parameters the tool does not accept.
 *
 * Rules describe the first-party tools that ship in `bundled-skills/`, and tool
 * names are not reserved: a managed, workspace, extra, or plugin skill may
 * define its own `subagent_read` with an entirely different contract. The
 * `bundled` prefix on the exports below is the reminder that callers must
 * establish bundled provenance before consulting the table.
 *
 * Pure data plus a lookup, with no imports from tool executors, so both the
 * skill-tool factory (`createSkillTool`, which validates before it reaches an
 * executor) and the executors themselves can consult it.
 */

interface ToolInputMisuseRule {
  /** Input keys that trigger this rule. Rules are matched in array order. */
  keys: readonly string[];
  /** Guidance returned in place of the generic validation error. */
  message: string;
}

const MISUSE_RULES: Readonly<Record<string, readonly ToolInputMisuseRule[]>> = {
  subagent_read: [
    {
      keys: ["path", "file", "filename"],
      message:
        "subagent_read returns a subagent's output, it does not read files. Use file_read for files. Pass subagent_id or label here.",
    },
    {
      keys: ["subagentId", "agent_id"],
      message: "Unknown parameter. Use subagent_id (snake_case) or label.",
    },
  ],
};

/**
 * Return the redirect for a misused parameter shape on a bundled tool, or
 * `undefined` when the tool has no rule for the keys present (the caller then
 * falls back to its own error message).
 *
 * Only call this for a tool that came from a bundled skill. `toolName` alone
 * does not establish that.
 */
export function bundledToolInputMisuseMessage(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const rules = MISUSE_RULES[toolName];
  if (!rules) {
    return undefined;
  }
  for (const rule of rules) {
    if (rule.keys.some((key) => key in input)) {
      return rule.message;
    }
  }
  return undefined;
}

/** Every key that carries a redirect for bundled `toolName`, for drift guards. */
export function bundledToolInputMisuseKeys(toolName: string): string[] {
  return (MISUSE_RULES[toolName] ?? []).flatMap((rule) => [...rule.keys]);
}

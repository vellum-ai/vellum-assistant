import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/** Envelope keys consumed by `skill_execute` itself, never inner-tool params. */
const SKILL_EXECUTE_ENVELOPE_KEYS = new Set(["tool", "input", "activity"]);

/**
 * Resolve the inner tool's parameters from a `skill_execute` envelope.
 *
 * The documented contract is `{ tool, input: {...}, activity }` — the inner
 * tool's parameters nested under `input`. A correctly nested, non-empty object
 * is returned unchanged, so well-formed callers are unaffected.
 *
 * Weaker models routinely misplace the parameters. Left unhandled, the inner
 * tool receives `{}`, fails schema validation ("<field> is required"), and the
 * model retries the identical malformed call until it gives up — the empty-
 * input retry loop. Two common misplacements are rescued so the call can
 * succeed instead:
 *
 * 1. `input` passed as a JSON-encoded string instead of an object.
 * 2. Parameters spread as top-level siblings of `tool`/`activity`, with `input`
 *    absent or an empty object.
 */
export function resolveSkillExecuteInput(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const raw = envelope.input;

  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    // A populated object is the well-formed case. An empty object falls
    // through to sibling rescue: the model may have nested nothing yet placed
    // the real parameters at the top level.
    if (Object.keys(obj).length > 0) return obj;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — fall through to sibling rescue.
    }
  }

  const siblings = Object.fromEntries(
    Object.entries(envelope).filter(
      ([key]) => !SKILL_EXECUTE_ENVELOPE_KEYS.has(key),
    ),
  );
  if (Object.keys(siblings).length > 0) return siblings;

  return {};
}

export const skillExecuteTool = {
  name: "skill_execute",
  description:
    "Execute a tool provided by a loaded skill. Use this instead of calling skill tools directly. The skill's instructions (from skill_load) describe available tools and their parameters. For browser automation, use the `assistant browser` CLI commands instead.",
  category: "skills",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description:
          "The skill tool name to execute (e.g. 'task_create', 'deploy_run')",
      },
      input: {
        type: "object",
        description:
          "Tool-specific parameters as documented in the skill's instructions",
      },
      activity: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are doing and why, shown as a progress update.",
      },
    },
    required: ["tool", "input", "activity"],
  },

  async execute(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return {
      content:
        "skill_execute should be intercepted at session level. If you see this error, the session dispatch is not configured.",
      isError: true,
    };
  },
} satisfies ToolDefinition;

registerTool(skillExecuteTool);

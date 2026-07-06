import { RiskLevel } from "../../permissions/types.js";
import { isUnparseableToolArgs } from "../../providers/unparseable-tool-args.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/** Envelope keys consumed by `skill_execute` itself, never inner-tool params. */
const SKILL_EXECUTE_ENVELOPE_KEYS = new Set(["tool", "input", "activity"]);

/**
 * Recover a `skill_execute` envelope that the provider layer wrapped under the
 * `_raw` unparseable marker.
 *
 * MiniMax's object→string argument coercion JSON-decodes the inner `input`
 * value after parsing the outer arguments. When the model passes a bare string
 * as `input` (e.g. Markdown body instead of `{ "content": "..." }`), that inner
 * decode fails and the whole call is marked unparseable — even though the outer
 * envelope is valid JSON. Re-parsing `_raw` recovers `{ tool, input, activity }`
 * so the inner tool can still be dispatched. A genuinely truncated/malformed
 * call's `_raw` won't parse and is returned unchanged, preserving the
 * retryable-error path for real stream corruption.
 */
export function recoverSkillExecuteEnvelope(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  if (!isUnparseableToolArgs(envelope)) return envelope;
  try {
    const parsed: unknown = JSON.parse(envelope._raw);
    if (
      parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Genuinely malformed/truncated — leave wrapped for the retryable error.
  }
  return envelope;
}

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
 * input retry loop. Three common misplacements are rescued so the call can
 * succeed instead:
 *
 * 1. `input` passed as a JSON-encoded string instead of an object.
 * 2. Parameters spread as top-level siblings of `tool`/`activity`, with `input`
 *    absent or an empty object.
 * 3. The sole required field's value passed bare as `input` (a non-JSON string)
 *    — e.g. the full Markdown body as `input` instead of `{ "content": "..." }`.
 *    Rescued only when `innerSchema` has exactly one required string field, so
 *    the mapping is unambiguous.
 */
export function resolveSkillExecuteInput(
  envelope: Record<string, unknown>,
  innerSchema?: unknown,
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
      // Not JSON. A weak model may have placed the inner tool's sole required
      // string value directly as `input` (e.g. the full Markdown body as
      // `document_update`'s `content`) instead of a `{ "content": "..." }`
      // object. When the inner tool has exactly one required string field, map
      // the bare string onto it rather than discarding content the model
      // actually produced.
      const field = soleRequiredStringField(innerSchema);
      if (field) return { [field]: raw };
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

/**
 * The single required string property of an inner tool's input schema, or
 * `null` when the schema has zero or more than one required field, or its lone
 * required field is not a string. Used to map a bare `input` string onto the
 * one field it can unambiguously belong to.
 */
function soleRequiredStringField(innerSchema: unknown): string | null {
  if (innerSchema == null || typeof innerSchema !== "object") return null;
  const schema = innerSchema as {
    required?: unknown;
    properties?: Record<string, { type?: unknown } | undefined>;
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length !== 1) return null;
  const field = required[0];
  if (typeof field !== "string") return null;
  return schema.properties?.[field]?.type === "string" ? field : null;
}

/**
 * Augment an inner-tool error with `skill_execute` envelope guidance when the
 * call carried no inner parameters.
 *
 * {@link resolveSkillExecuteInput} rescues *misplaced* parameters (siblings, a
 * JSON-encoded string). It cannot rescue a genuinely empty call — there is
 * nothing to relocate — so the inner tool runs with `{}` and rejects it with a
 * field-level message ("<field> is required") that says nothing about the
 * envelope. Weak models then retry the identical empty shape, oscillating over
 * whether parameters belong under `input`, as siblings, or as a JSON string.
 *
 * Appending the canonical envelope shape gives the next attempt a concrete
 * template. Fires only when the resolved inner input was empty AND the tool
 * errored, so well-formed calls and tools that legitimately accept no
 * parameters are untouched.
 */
export function augmentSkillExecuteError(
  toolName: string,
  resolvedInput: Record<string, unknown>,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (!result.isError || Object.keys(resolvedInput).length > 0) return result;

  const guidance =
    `\n\nThis skill_execute call carried no parameters for "${toolName}". ` +
    `Put the tool's parameters inside \`input\`. For example: ` +
    `{"tool": "${toolName}", "input": { /* the tool's parameters */ }, ` +
    `"activity": "..."}. The skill's instructions (from skill_load) list ` +
    `"${toolName}"'s required fields.`;

  return { ...result, content: result.content + guidance };
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

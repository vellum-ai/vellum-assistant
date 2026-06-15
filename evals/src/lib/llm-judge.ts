/**
 * Single-call LLM judge used by metrics that need a model to classify or
 * grade free-form assistant output rather than match brittle string patterns.
 *
 * A judge call is harness-owned traffic, not assistant traffic, so it prices
 * from its own usage and runs outside the egress jail — it reaches the
 * Anthropic API directly with the harness's `ANTHROPIC_API_KEY`, the same
 * transport the user simulator uses.
 *
 * The judge is forced to answer through a single tool call (`tool_choice`),
 * so the verdict comes back as structured tool input rather than free text
 * that would need its own parser.
 */
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Haiku is the cheapest model that classifies reliably; matches the simulator. */
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_MAX_TOKENS = 1024;

export interface JudgeToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface JudgeRequest {
  /** System prompt framing the grading task. */
  system: string;
  /** User-role content the judge inspects (e.g. the assistant's answer). */
  user: string;
  /** The single tool the judge is forced to call to return its verdict. */
  tool: JudgeToolSpec;
  apiKey?: string;
  model?: string;
}

interface ToolUsePart {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface JudgeResponseBody {
  content?: ToolUsePart[];
}

/**
 * Run one judge call and return the forced tool call's input. Throws if the
 * API key is missing, the request fails, or the response carries no matching
 * `tool_use` block.
 */
export async function classifyWithJudge(
  request: JudgeRequest,
): Promise<Record<string, unknown>> {
  const apiKey = request.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run the LLM judge");
  }
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model ?? DEFAULT_JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      temperature: 0,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      tools: [
        {
          name: request.tool.name,
          description: request.tool.description,
          input_schema: request.tool.inputSchema,
        },
      ],
      tool_choice: { type: "tool", name: request.tool.name },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `LLM judge request failed ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as JudgeResponseBody;
  const toolUse = (body.content ?? []).find(
    (part) => part.type === "tool_use" && part.name === request.tool.name,
  );
  if (!toolUse?.input) {
    throw new Error(
      `LLM judge returned no ${request.tool.name} tool call (content: ${JSON.stringify(body.content ?? [])})`,
    );
  }
  return toolUse.input;
}

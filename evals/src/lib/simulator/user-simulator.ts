import { readFile } from "node:fs/promises";

import type {
  Simulator,
  SimulatorDecision,
  SimulatorInput,
  ToolConfirmationRequest,
} from "./types";
import type { TranscriptTurn } from "../transcript";

export const DEFAULT_SIMULATOR_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TURNS = 100;
export const MAX_OUTPUT_TOKENS = 8192;
/** Name of the tool the simulator calls to resolve a pending confirmation. */
export const CONFIRMATION_TOOL_NAME = "respond_to_confirmation";
/** Clip length for the raw response body included in parse-failure diagnostics. */
export const PARSE_FAILURE_BODY_CLIP = 2000;

/** Opening system-prompt lines shared by every simulator call. */
const SIMULATOR_PERSONA_LINES = [
  "You are the user simulator in an eval harness.",
  "You are controlling the user side of a conversation with the tested agent.",
];
/** Guards against the simulator leaking hidden SPEC answers to the agent. */
const SIMULATOR_SECRECY_LINE =
  "Do not reveal hidden test answers unless the SPEC explicitly says to reveal them.";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicToolChoice {
  type: "tool";
  name: string;
}

interface SimulatorRequest {
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicToolSpec[];
  /** Forces a specific tool call; omitted to let the model free-text. */
  toolChoice?: AnthropicToolChoice;
  /** Phrase describing the call, used in the failure message. */
  failureLabel: string;
}

interface UserSimulatorOptions {
  apiKey?: string;
  model?: string;
  maxTurns?: number;
}

interface TextPart {
  type: "text";
  text: string;
}

interface ToolUsePart {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

type ContentPart = TextPart | ToolUsePart;

interface AnthropicResponseBody {
  content?: ContentPart[];
  stop_reason?: string;
}

function simulatorTurnCount(transcript: TranscriptTurn[]): number {
  return transcript.filter((turn) => turn.role === "simulator").length;
}

function coalesceMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const coalesced: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = coalesced.at(-1);
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      coalesced.push({ ...message });
    }
  }
  return coalesced;
}

function transcriptToSimulatorMessages(
  transcript: TranscriptTurn[],
): AnthropicMessage[] {
  const messages = transcript.map((turn) => ({
    role:
      turn.role === "assistant" ? ("user" as const) : ("assistant" as const),
    content: `[${turn.emittedAt}] ${turn.content}`,
  }));

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({
      role: "user",
      content:
        "The eval conversation is starting. Write the first user message to send to the tested agent.",
    });
  }

  return coalesceMessages(messages);
}

function textDecision(parts: ContentPart[]): SimulatorDecision | undefined {
  const text = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text ? { action: "send", message: { content: text } } : undefined;
}

function toolDecision(parts: ContentPart[]): SimulatorDecision | undefined {
  const end = parts.find(
    (part): part is ToolUsePart =>
      part.type === "tool_use" && part.name === "end_conversation",
  );
  if (!end) return undefined;
  return {
    action: "end",
    reason: String(end.input?.reason ?? "simulator ended the conversation"),
  };
}

/**
 * Recover from the "model returned empty content with stop_reason=end_turn"
 * failure mode by synthesizing an implicit `end_conversation` decision.
 *
 * Anthropic's Haiku 4.5 has been observed to return `content=[]` with
 * `stop_reason=end_turn` when it judges the conversation is over, instead of
 * calling the `end_conversation` tool the SPEC + system prompt instruct it to
 * use. Concrete sighting: `eval-vellum-bare-timeline-recall-20260520135745`
 * turn 2 — after the assistant said it couldn't find the date, the SPEC's
 * "acknowledge briefly and end" branch fired and the model just… emitted
 * nothing (input_tokens=1000, output_tokens=3, so this isn't a context
 * window or max_tokens cap, it's a model-side decision-to-be-silent).
 *
 * We honor the signal: `end_turn` means the model believes the turn is
 * complete, so treating empty content as "end the conversation" matches the
 * model's apparent intent and unblocks the metrics pass. Only triggers for
 * the exact `end_turn` + no-actionable-content shape — `max_tokens`, novel
 * tool calls, refusals, and whitespace-only text with other stop reasons
 * keep throwing `SimulatorParseError` so genuine bugs remain visible.
 */
function implicitEndDecision(
  body: AnthropicResponseBody,
): SimulatorDecision | undefined {
  if (body.stop_reason !== "end_turn") return undefined;
  const parts = body.content ?? [];
  // Only recover when the model gave us *nothing* actionable: no parts at
  // all, or text parts that trim to empty. If Anthropic returns any other
  // part shape (including an unexpected tool), keep throwing so the novel
  // response remains visible in diagnostics instead of being swallowed as a
  // benign end-turn.
  const textParts: TextPart[] = [];
  for (const part of parts) {
    if (part.type !== "text") return undefined;
    textParts.push(part);
  }
  const hasText = textParts.some((part) => part.text.trim().length > 0);
  if (hasText) return undefined;
  return {
    action: "end",
    reason:
      "simulator returned empty content with stop_reason=end_turn; treating as implicit end_conversation",
  };
}

function describeContentPart(part: ContentPart): string {
  if (part.type === "text") {
    if (part.text.length === 0) return "text(empty)";
    if (part.text.trim().length === 0) {
      return `text(whitespace, length=${part.text.length})`;
    }
    return `text(length=${part.text.length})`;
  }
  if (part.type === "tool_use") {
    return `tool_use(name=${part.name})`;
  }
  return `type=${(part as { type?: string }).type ?? "unknown"}`;
}

function summarizeContentParts(parts: ContentPart[]): string {
  if (parts.length === 0) return "[]";
  return `[${parts.map(describeContentPart).join(", ")}]`;
}

function clipForDiagnostic(body: AnthropicResponseBody): string {
  const json = JSON.stringify(body);
  if (json.length <= PARSE_FAILURE_BODY_CLIP) return json;
  const remaining = json.length - PARSE_FAILURE_BODY_CLIP;
  return `${json.slice(0, PARSE_FAILURE_BODY_CLIP)}… (clipped ${remaining} chars)`;
}

/**
 * Thrown when the Anthropic response can't be decoded into a `send` or `end`
 * decision (empty content array, whitespace-only text, hit max_tokens with no
 * usable output, novel tool call, refusal, …).
 *
 * Carries a structured `headline` + `details` pair so the runner's progress
 * reporter can render the failure inline (red `✗` line with the breakdown
 * nested under it) instead of forcing operators to grep a flat JSON string.
 * The `.message` still concatenates everything for the JSON-line emitter and
 * for any other consumer that only sees `Error.message`.
 */
export class SimulatorParseError extends Error {
  readonly headline: string;
  readonly details: string[];

  constructor(headline: string, details: string[]) {
    super(details.length > 0 ? `${headline}. ${details.join("; ")}` : headline);
    this.name = "SimulatorParseError";
    this.headline = headline;
    this.details = details;
  }
}

function parseDecision(body: AnthropicResponseBody): SimulatorDecision {
  const parts = body.content ?? [];
  const decision =
    toolDecision(parts) ?? textDecision(parts) ?? implicitEndDecision(body);
  if (decision) return decision;
  // Surface enough structured info to triage what kind of response came back
  // so we can intentionally handle each failure mode (empty content, hit
  // max_tokens, whitespace-only text, unknown tool call, refusal, …) rather
  // than blindly retrying. Each detail entry stands on its own line in the
  // CLI reporter so operators can scan stop_reason / parts / body separately.
  throw new SimulatorParseError(
    "User simulator response had no actionable content",
    [
      `stop_reason=${body.stop_reason ?? "unknown"}`,
      `parts=${summarizeContentParts(parts)}`,
      `body: ${clipForDiagnostic(body)}`,
    ],
  );
}

/**
 * Render a pending tool confirmation as the trailing user-turn message the
 * simulator decides on. The tested agent is the "user" role in the simulator
 * transcript (see `transcriptToSimulatorMessages`), so its permission request
 * naturally reads as the latest user turn.
 */
function confirmationPrompt(request: ToolConfirmationRequest): string {
  const lines = [
    "The agent has paused to ask your permission before running a tool.",
    `Tool: ${request.toolName || "(unnamed)"}`,
    `Input: ${JSON.stringify(request.input)}`,
  ];
  if (request.riskLevel) lines.push(`Risk level: ${request.riskLevel}`);
  if (request.riskReason) lines.push(`Risk reason: ${request.riskReason}`);
  lines.push(
    "Decide whether to allow or deny this tool call by calling respond_to_confirmation.",
  );
  return lines.join("\n");
}

function parseConfirmationDecision(
  body: AnthropicResponseBody,
): SimulatorDecision {
  const parts = body.content ?? [];
  for (const part of parts) {
    if (part.type !== "tool_use" || part.name !== CONFIRMATION_TOOL_NAME) {
      continue;
    }
    const decision = part.input?.decision;
    if (decision === "allow" || decision === "deny") {
      const reason = part.input?.reason;
      return {
        action: "confirm",
        decision,
        reason: typeof reason === "string" ? reason : undefined,
      };
    }
  }
  // `tool_choice` forces the model to call `respond_to_confirmation`, so a
  // missing or malformed decision means the response shape changed out from
  // under us. Surface it the same structured way `parseDecision` does so the
  // runner's fallback path logs something actionable.
  throw new SimulatorParseError(
    "User simulator confirmation response had no allow/deny decision",
    [
      `stop_reason=${body.stop_reason ?? "unknown"}`,
      `parts=${summarizeContentParts(parts)}`,
      `body: ${clipForDiagnostic(body)}`,
    ],
  );
}

export class UserSimulator implements Simulator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTurns: number;

  constructor(opts: UserSimulatorOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is required to run the user simulator",
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_SIMULATOR_MODEL;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  async decide(input: SimulatorInput): Promise<SimulatorDecision> {
    // A pending confirmation is the simulator's next decision regardless of
    // where the turn stands, so resolve it before the turn-budget guard (which
    // is about how many user messages to send, not mid-turn approvals).
    if (input.pendingConfirmation) {
      return this.decideConfirmation(input, input.pendingConfirmation);
    }

    const turns = simulatorTurnCount(input.transcript);
    if (turns >= this.maxTurns) {
      return {
        action: "end",
        reason: `max simulator turns reached (${this.maxTurns})`,
      };
    }
    return this.decideNextMessage(input);
  }

  private async decideNextMessage(
    input: SimulatorInput,
  ): Promise<SimulatorDecision> {
    const spec = await readFile(input.test.specPath, "utf8");
    const body = await this.requestCompletion({
      failureLabel: "request",
      system: [
        ...SIMULATOR_PERSONA_LINES,
        "Follow the test SPEC exactly.",
        "Your assistant text is sent verbatim as the next user message to the tested agent.",
        "When the SPEC end condition is met, call the end_conversation tool with a short reason.",
        SIMULATOR_SECRECY_LINE,
        // Every response MUST be actionable — either non-empty text or an
        // end_conversation tool call. An empty response stalls the eval
        // (observed in real runs where Haiku returned content=[] with
        // stop_reason=end_turn on turn 3 of timeline-recall). If the
        // SPEC end condition is met, call end_conversation; if you
        // are unsure how to proceed, call end_conversation with a
        // reason that explains the uncertainty.
        "Every response must either contain non-empty user text or call the end_conversation tool. Never return an empty response.",
        "If you are unsure how to continue, call end_conversation with a reason that explains why.",
        "",
        "SPEC:",
        spec,
      ].join("\n"),
      messages: transcriptToSimulatorMessages(input.transcript),
      tools: [
        {
          name: "end_conversation",
          description:
            "End the eval conversation because the SPEC end condition has been met.",
          input_schema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      ],
    });
    return parseDecision(body);
  }

  private async decideConfirmation(
    input: SimulatorInput,
    request: ToolConfirmationRequest,
  ): Promise<SimulatorDecision> {
    const spec = await readFile(input.test.specPath, "utf8");
    const body = await this.requestCompletion({
      failureLabel: "confirmation request",
      system: [
        ...SIMULATOR_PERSONA_LINES,
        "The tested agent has paused to ask your permission before running a tool it judged risky.",
        "Decide as the user would, following the SPEC: allow tool calls that advance the SPEC's goal, and deny calls that are unsafe, off-task, or that the SPEC says to refuse.",
        "Respond only by calling the respond_to_confirmation tool with your decision.",
        SIMULATOR_SECRECY_LINE,
        "",
        "SPEC:",
        spec,
      ].join("\n"),
      messages: coalesceMessages([
        ...transcriptToSimulatorMessages(input.transcript),
        { role: "user", content: confirmationPrompt(request) },
      ]),
      tools: [
        {
          name: CONFIRMATION_TOOL_NAME,
          description:
            "Allow or deny the tool the agent asked permission to run.",
          input_schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["allow", "deny"] },
              reason: { type: "string" },
            },
            required: ["decision"],
          },
        },
      ],
      // Resolving the confirmation is the only valid move here, so force the
      // tool call rather than risk a free-text reply that never resolves it.
      // The next-message path omits tool_choice so the model can choose
      // between user text and ending the conversation.
      toolChoice: { type: "tool", name: CONFIRMATION_TOOL_NAME },
    });
    return parseConfirmationDecision(body);
  }

  /**
   * One round-trip to the simulator model. Both the turn-taking decision and
   * the mid-turn confirmation verdict are single Anthropic calls that differ
   * only in their prompt, tools, and parser, so they share this transport.
   */
  private async requestCompletion(
    request: SimulatorRequest,
  ): Promise<AnthropicResponseBody> {
    const payload: Record<string, unknown> = {
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    };
    if (request.toolChoice) {
      payload.tool_choice = request.toolChoice;
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `User simulator ${request.failureLabel} failed ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as AnthropicResponseBody;
  }
}

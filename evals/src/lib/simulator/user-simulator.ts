import { readFile } from "node:fs/promises";

import type { Simulator, SimulatorDecision, SimulatorInput } from "./types";
import type { TranscriptTurn } from "../transcript";

export const DEFAULT_SIMULATOR_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TURNS = 100;
export const MAX_OUTPUT_TOKENS = 8192;
/** Clip length for the raw response body included in parse-failure diagnostics. */
export const PARSE_FAILURE_BODY_CLIP = 2000;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
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
  const decision = toolDecision(parts) ?? textDecision(parts);
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
    const turns = simulatorTurnCount(input.transcript);
    if (turns >= this.maxTurns) {
      return {
        action: "end",
        reason: `max simulator turns reached (${this.maxTurns})`,
      };
    }

    const spec = await readFile(input.test.specPath, "utf8");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: [
          "You are the user simulator in an eval harness.",
          "You are controlling the user side of a conversation with the tested agent.",
          "Follow the test SPEC exactly.",
          "Your assistant text is sent verbatim as the next user message to the tested agent.",
          "When the SPEC end condition is met, call the end_conversation tool with a short reason.",
          "Do not reveal hidden test answers unless the SPEC explicitly says to reveal them.",
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
      }),
    });

    if (!response.ok) {
      throw new Error(
        `User simulator request failed ${response.status}: ${await response.text()}`,
      );
    }

    return parseDecision((await response.json()) as AnthropicResponseBody);
  }
}

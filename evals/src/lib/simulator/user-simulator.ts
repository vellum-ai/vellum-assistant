import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Simulator, SimulatorDecision, SimulatorInput } from "./types";
import type { TranscriptTurn } from "../transcript";

export const DEFAULT_SIMULATOR_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TURNS = 100;
export const MAX_OUTPUT_TOKENS = 8192;
/**
 * Number of extra attempts to make when the model returns a response that
 * has neither text nor an `end_conversation` tool call. Total attempts =
 * 1 + DEFAULT_MAX_PARSE_RETRIES. Retries bump temperature off zero so we
 * don't just resample the same deterministic broken response.
 */
export const DEFAULT_MAX_PARSE_RETRIES = 2;
export const PARSE_RETRY_BASE_DELAY_MS = 250;
export const PARSE_RETRY_TEMPERATURE = 0.3;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSimulatorOptions {
  apiKey?: string;
  model?: string;
  maxTurns?: number;
  maxParseRetries?: number;
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

function tryParseDecision(parts: ContentPart[]): SimulatorDecision | undefined {
  return toolDecision(parts) ?? textDecision(parts);
}

export class UserSimulator implements Simulator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly maxParseRetries: number;

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
    this.maxParseRetries = Math.max(
      0,
      opts.maxParseRetries ?? DEFAULT_MAX_PARSE_RETRIES,
    );
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
    const messages = transcriptToSimulatorMessages(input.transcript);

    let lastBody: AnthropicResponseBody | undefined;
    for (let attempt = 0; attempt <= this.maxParseRetries; attempt++) {
      // First attempt is deterministic (temperature 0). Retries bump
      // temperature so we don't just re-sample the same broken response.
      const temperature = attempt === 0 ? 0 : PARSE_RETRY_TEMPERATURE;
      lastBody = await this.callAnthropic({ spec, messages, temperature });

      const decision = tryParseDecision(lastBody.content ?? []);
      if (decision) return decision;

      if (attempt < this.maxParseRetries) {
        await sleep(PARSE_RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }

    const totalAttempts = this.maxParseRetries + 1;
    throw new Error(
      `User simulator response did not include text or end_conversation tool call ` +
        `(after ${totalAttempts} attempt${totalAttempts === 1 ? "" : "s"}; ` +
        `last stop_reason=${lastBody?.stop_reason ?? "unknown"}, ` +
        `content parts=${lastBody?.content?.length ?? 0})`,
    );
  }

  private async callAnthropic(args: {
    spec: string;
    messages: AnthropicMessage[];
    temperature: number;
  }): Promise<AnthropicResponseBody> {
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
        temperature: args.temperature,
        system: [
          "You are the user simulator in an eval harness.",
          "You are controlling the user side of a conversation with the tested agent.",
          "Follow the test SPEC exactly.",
          "Your assistant text is sent verbatim as the next user message to the tested agent.",
          "When the SPEC end condition is met, call the end_conversation tool with a short reason.",
          "Do not reveal hidden test answers unless the SPEC explicitly says to reveal them.",
          "",
          "SPEC:",
          args.spec,
        ].join("\n"),
        messages: args.messages,
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

    return (await response.json()) as AnthropicResponseBody;
  }
}

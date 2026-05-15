import { readFile } from "node:fs/promises";

import type { Simulator, SimulatorDecision, SimulatorInput } from "./types";
import type { TranscriptTurn } from "../transcript";

export const DEFAULT_SIMULATOR_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MAX_TURNS = 100;
export const MAX_OUTPUT_TOKENS = 8192;

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

function parseDecision(parts: ContentPart[]): SimulatorDecision {
  const end = toolDecision(parts);
  if (end) return end;
  const send = textDecision(parts);
  if (send) return send;
  throw new Error(
    "User simulator response did not include text or end_conversation tool call",
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

    const body = (await response.json()) as { content?: ContentPart[] };
    return parseDecision(body.content ?? []);
  }
}

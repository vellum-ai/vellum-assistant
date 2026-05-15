import { readFile } from "node:fs/promises";

import type { Simulator, SimulatorDecision, SimulatorInput } from "./types";
import type { TranscriptTurn } from "../transcript";

const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_MAX_TURNS = 100;
const MAX_OUTPUT_TOKENS = 8192;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserSimulatorOptions {
  apiKey?: string;
  model?: string;
  maxTurns?: number;
}

interface ToolUsePart {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

function simulatorTurnCount(transcript: TranscriptTurn[]): number {
  return transcript.filter(
    (turn) => turn.role === "simulator" && turn.phase !== "setup",
  ).length;
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
    content: `[${turn.emittedAt}${turn.phase ? ` ${turn.phase}` : ""}] ${turn.content}`,
  }));

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({
      role: "user",
      content:
        "The eval conversation is starting. Choose the first user message to send to the tested agent.",
    });
  }

  return coalesceMessages(messages);
}

function parseToolDecision(parts: ToolUsePart[]): SimulatorDecision {
  const tool = parts.find(
    (part) =>
      part.name === "send_agent_message" || part.name === "end_conversation",
  );
  if (!tool)
    throw new Error(
      "User simulator response did not include a supported tool call",
    );

  if (tool.name === "end_conversation") {
    return {
      action: "end",
      reason: String(tool.input?.reason ?? "simulator ended the conversation"),
    };
  }

  const content = tool.input?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(
      "send_agent_message tool call must include non-empty content",
    );
  }
  return {
    action: "send",
    message: { content },
    reason:
      typeof tool.input?.reason === "string" ? tool.input.reason : undefined,
  };
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
    this.model =
      opts.model ?? process.env.EVALS_SIMULATOR_MODEL ?? DEFAULT_MODEL;
    this.maxTurns =
      opts.maxTurns ?? Number(process.env.EVALS_MAX_TURNS ?? DEFAULT_MAX_TURNS);
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
          "Use send_agent_message when the tested agent should receive another user message.",
          "Use end_conversation when the SPEC end condition is met.",
          "Do not reveal hidden test answers unless the SPEC explicitly says to reveal them.",
          "",
          "SPEC:",
          spec,
        ].join("\n"),
        messages: transcriptToSimulatorMessages(input.transcript),
        tools: [
          {
            name: "send_agent_message",
            description: "Send the next user message to the tested agent.",
            input_schema: {
              type: "object",
              properties: {
                content: { type: "string" },
                reason: { type: "string" },
              },
              required: ["content"],
            },
          },
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
        tool_choice: { type: "any" },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `User simulator request failed ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as { content?: ToolUsePart[] };
    return parseToolDecision(body.content ?? []);
  }
}

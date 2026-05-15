import { readFile } from "node:fs/promises";

import type { AgentEvent } from "../adapter";
import type { Simulator, SimulatorDecision, SimulatorInput } from "./types";

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_MAX_TURNS = 8;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface HaikuSimulatorOptions {
  apiKey?: string;
  model?: string;
  maxTurns?: number;
  fetchImpl?: typeof fetch;
}

function eventText(event: AgentEvent): string | undefined {
  const message = event.message;
  return message.text ?? message.content ?? message.message ?? message.chunk;
}

function renderAssistantEvents(events: AgentEvent[]): string {
  const lines = events
    .map(eventText)
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => text.trim());
  return lines.length > 0 ? lines.join("\n") : "(no assistant message yet)";
}

function coerceDecision(raw: string): SimulatorDecision {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`Simulator returned non-JSON decision: ${trimmed}`);
  }

  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
    action?: unknown;
    message?: unknown;
    reason?: unknown;
  };
  if (parsed.action === "end") {
    return {
      action: "end",
      reason: String(parsed.reason ?? "simulator ended"),
    };
  }
  if (parsed.action === "send" && typeof parsed.message === "string") {
    return {
      action: "send",
      message: { content: parsed.message },
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }
  throw new Error(`Simulator returned invalid decision: ${trimmed}`);
}

export class HaikuSimulator implements Simulator {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HaikuSimulatorOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model =
      opts.model ?? process.env.EVALS_SIMULATOR_MODEL ?? DEFAULT_MODEL;
    this.maxTurns =
      opts.maxTurns ?? Number(process.env.EVALS_MAX_TURNS ?? DEFAULT_MAX_TURNS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async decide(input: SimulatorInput): Promise<SimulatorDecision> {
    if (input.transcript.length >= this.maxTurns) {
      return { action: "end", reason: `max turns reached (${this.maxTurns})` };
    }

    const spec = await readFile(input.test.specPath, "utf8");
    const assistantText = renderAssistantEvents(input.assistantEvents);
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [
          "You are the simulator in an eval harness. Follow the test SPEC exactly.",
          "Return ONLY JSON in one of these shapes:",
          '{"action":"send","message":"<next user message>","reason":"<short reason>"}',
          '{"action":"end","reason":"<why the conversation is done>"}',
          "",
          "SPEC:",
          spec,
          "",
          "Conversation so far:",
          JSON.stringify(input.transcript, null, 2),
          "",
          "Latest assistant event text:",
          assistantText,
        ].join("\n"),
      },
    ];

    if (!this.apiKey) {
      return fallbackDecision(input);
    }

    const response = await this.fetchImpl(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          temperature: 0,
          messages,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Haiku simulator request failed ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content?.find((part) => part.type === "text")?.text;
    if (!text)
      throw new Error("Haiku simulator response did not include text content");
    return coerceDecision(text);
  }
}

function fallbackDecision(input: SimulatorInput): SimulatorDecision {
  const hasSimulatorMessage = input.transcript.some(
    (turn) => turn.role === "simulator",
  );
  if (!hasSimulatorMessage) {
    return {
      action: "send",
      message: {
        content: "What date did I mention my partner's peanut allergy?",
      },
      reason: "deterministic fallback opening message",
    };
  }
  return {
    action: "end",
    reason:
      "ANTHROPIC_API_KEY not set; deterministic fallback stops after opening turn",
  };
}

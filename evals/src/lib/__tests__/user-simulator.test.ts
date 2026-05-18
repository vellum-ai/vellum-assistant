import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SIMULATOR_MODEL,
  PARSE_RETRY_TEMPERATURE,
  UserSimulator,
} from "../simulator/user-simulator";
import type { TestDef } from "../test-def";

const originalFetch = globalThis.fetch;

async function makeTestDef(): Promise<TestDef> {
  const dir = await mkdtemp(join(tmpdir(), "evals-sim-"));
  const specPath = join(dir, "SPEC.md");
  await writeFile(specPath, "# spec", "utf8");
  return {
    id: "timeline-recall",
    specPath,
    setupPath: join(dir, "setup.ts"),
    setupCommands: [],
    metricsDir: join(dir, "metrics"),
    metricPaths: [],
  };
}

describe("UserSimulator", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("requires an Anthropic API key", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new UserSimulator()).toThrow("ANTHROPIC_API_KEY is required");
    if (previous) process.env.ANTHROPIC_API_KEY = previous;
  });

  test("sends plain simulator text as the next agent message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-sim-"));
    const specPath = join(dir, "SPEC.md");
    await writeFile(specPath, "# spec", "utf8");

    let requestBody: unknown;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "What date did I mention my partner's peanut allergy?",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 2 });
    const decision = await simulator.decide({
      test: {
        id: "timeline-recall",
        specPath,
        setupPath: join(dir, "setup.ts"),
        setupCommands: [],
        metricsDir: join(dir, "metrics"),
        metricPaths: [],
      },
      transcript: [
        { role: "assistant", content: "hello", emittedAt: "t1" },
        { role: "assistant", content: "still hello", emittedAt: "t2" },
      ],
    });

    expect(decision).toEqual({
      action: "send",
      message: {
        content: "What date did I mention my partner's peanut allergy?",
      },
    });
    expect(requestBody).toMatchObject({
      model: DEFAULT_SIMULATOR_MODEL,
      max_tokens: 8192,
    });
    expect(requestBody).toMatchObject({
      tools: [expect.objectContaining({ name: "end_conversation" })],
    });
    expect(requestBody).not.toHaveProperty("tool_choice");
  });

  test("uses end_conversation tool to end the conversation with a reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-sim-"));
    const specPath = join(dir, "SPEC.md");
    await writeFile(specPath, "# spec", "utf8");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "end_conversation",
              input: { reason: "done" },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 2 });
    const decision = await simulator.decide({
      test: {
        id: "timeline-recall",
        specPath,
        setupPath: join(dir, "setup.ts"),
        setupCommands: [],
        metricsDir: join(dir, "metrics"),
        metricPaths: [],
      },
      transcript: [],
    });

    expect(decision).toEqual({ action: "end", reason: "done" });
  });

  test("ends when max simulator turns are reached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-sim-"));
    const specPath = join(dir, "SPEC.md");
    await writeFile(specPath, "# spec", "utf8");
    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 1 });

    const decision = await simulator.decide({
      test: {
        id: "timeline-recall",
        specPath,
        setupPath: join(dir, "setup.ts"),
        setupCommands: [],
        metricsDir: join(dir, "metrics"),
        metricPaths: [],
      },
      transcript: [
        { role: "simulator", content: "one", emittedAt: "t1" },
        { role: "assistant", content: "reply", emittedAt: "t2" },
      ],
    });

    expect(decision).toEqual({
      action: "end",
      reason: "max simulator turns reached (1)",
    });
  });

  test("retries once when the model returns an empty content array", async () => {
    const test = await makeTestDef();

    const responses: Array<{ content: unknown[]; stop_reason: string }> = [
      { content: [], stop_reason: "end_turn" },
      {
        content: [{ type: "text", text: "now I have an answer" }],
        stop_reason: "end_turn",
      },
    ];
    const requests: Array<{ temperature: number }> = [];
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { temperature: number };
      requests.push({ temperature: body.temperature });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra fetch call");
      return new Response(JSON.stringify(next), { status: 200 });
    }) as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    const decision = await simulator.decide({ test, transcript: [] });

    expect(decision).toEqual({
      action: "send",
      message: { content: "now I have an answer" },
    });
    expect(requests).toEqual([
      { temperature: 0 },
      { temperature: PARSE_RETRY_TEMPERATURE },
    ]);
  });

  test("retries on whitespace-only text responses", async () => {
    const test = await makeTestDef();

    const responses: Array<{ content: unknown[]; stop_reason: string }> = [
      {
        content: [{ type: "text", text: "   \n  " }],
        stop_reason: "end_turn",
      },
      {
        content: [{ type: "text", text: "real message" }],
        stop_reason: "end_turn",
      },
    ];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
      })) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    const decision = await simulator.decide({ test, transcript: [] });

    expect(decision).toEqual({
      action: "send",
      message: { content: "real message" },
    });
  });

  test("throws with stop_reason context after exhausting retries", async () => {
    const test = await makeTestDef();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ content: [], stop_reason: "max_tokens" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const simulator = new UserSimulator({
      apiKey: "test-key",
      maxTurns: 5,
      maxParseRetries: 2,
    });

    await expect(simulator.decide({ test, transcript: [] })).rejects.toThrow(
      /after 3 attempts.*stop_reason=max_tokens.*content parts=0/,
    );
    expect(calls).toBe(3);
  });

  test("maxParseRetries=0 disables retries (single attempt)", async () => {
    const test = await makeTestDef();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ content: [], stop_reason: "end_turn" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const simulator = new UserSimulator({
      apiKey: "test-key",
      maxTurns: 5,
      maxParseRetries: 0,
    });

    await expect(simulator.decide({ test, transcript: [] })).rejects.toThrow(
      /after 1 attempt;/,
    );
    expect(calls).toBe(1);
  });
});

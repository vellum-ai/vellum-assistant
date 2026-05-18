import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_SIMULATOR_MODEL,
  SimulatorParseError,
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

  test("parse failure surfaces stop_reason, part summary, and clipped body", async () => {
    const test = await makeTestDef();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ content: [], stop_reason: "max_tokens" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    let captured: Error | undefined;
    try {
      await simulator.decide({ test, transcript: [] });
    } catch (err) {
      captured = err as Error;
    }

    // No retries — one call, one failure.
    expect(calls).toBe(1);
    expect(captured).toBeDefined();
    const message = captured!.message;
    expect(message).toContain("had no actionable content");
    expect(message).toContain("stop_reason=max_tokens");
    expect(message).toContain("parts=[]");
    // The full clipped body JSON is present so we can grep failure modes.
    expect(message).toContain('"stop_reason":"max_tokens"');

    // The structured shape lets the CLI reporter render `headline` as the red
    // header line and each `details` entry as its own indented row beneath —
    // not just one flat JSON string in stdout.
    expect(captured).toBeInstanceOf(SimulatorParseError);
    const parseErr = captured as SimulatorParseError;
    expect(parseErr.headline).toBe(
      "User simulator response had no actionable content",
    );
    expect(parseErr.details).toEqual([
      "stop_reason=max_tokens",
      "parts=[]",
      expect.stringMatching(/^body: \{.*"stop_reason":"max_tokens".*\}$/),
    ]);
  });

  test("parse failure summarizes non-empty content parts", async () => {
    const test = await makeTestDef();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "   \n  " },
            { type: "tool_use", name: "ask_clarification", input: {} },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    await expect(simulator.decide({ test, transcript: [] })).rejects.toThrow(
      /stop_reason=tool_use.*parts=\[text\(whitespace, length=6\), tool_use\(name=ask_clarification\)\]/,
    );
  });

  test("system prompt forbids empty responses and tells the model to end_conversation when stuck", async () => {
    // Regression guard for the real `vellum-bare timeline-recall` failure
    // (turn 3) where Haiku returned content=[] + stop_reason=end_turn.
    // The system prompt must explicitly forbid empty responses and steer
    // the model toward end_conversation when it doesn't know what to say,
    // so the same conversation never reproduces the empty-content stall.
    const test = await makeTestDef();
    let requestBody: { system?: string } | undefined;

    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    await simulator.decide({ test, transcript: [] });

    expect(typeof requestBody?.system).toBe("string");
    const system = String(requestBody?.system);
    expect(system).toContain("Never return an empty response");
    expect(system).toContain(
      "call end_conversation with a reason that explains why",
    );
  });
});

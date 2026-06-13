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

  test("treats empty content with stop_reason=end_turn as implicit end_conversation", async () => {
    // Regression guard for the real `eval-vellum-bare-timeline-recall-
    // 20260520135745` turn 2 failure where Haiku returned content=[] +
    // stop_reason=end_turn. Per SPEC the simulator should have called
    // end_conversation; the model's end_turn signal carries the same
    // semantic ("I'm done"), so we honor it instead of throwing and
    // killing the run before metrics can score the transcript.
    const test = await makeTestDef();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ content: [], stop_reason: "end_turn" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    const decision = await simulator.decide({ test, transcript: [] });

    // Single attempt — no retries, no extra API spend.
    expect(calls).toBe(1);
    expect(decision.action).toBe("end");
    if (decision.action === "end") {
      expect(decision.reason).toContain("empty content");
      expect(decision.reason).toContain("end_turn");
      expect(decision.reason).toContain("implicit end_conversation");
    }
  });

  test("end_turn with usable text remains a normal send decision", async () => {
    // Belt-and-braces: an end_turn response WITH usable text is still a
    // normal "send" decision, not an implicit end. This guards against
    // accidentally swallowing the final substantive simulator reply.
    const test = await makeTestDef();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Thanks, that helps." }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    const decision = await simulator.decide({ test, transcript: [] });

    expect(decision).toEqual({
      action: "send",
      message: { content: "Thanks, that helps." },
    });
  });

  test("whitespace-only text with stop_reason=end_turn is also treated as implicit end_conversation", async () => {
    const test = await makeTestDef();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "   \n  " }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });
    const decision = await simulator.decide({ test, transcript: [] });

    expect(decision.action).toBe("end");
  });

  test("unexpected tool calls with stop_reason=end_turn still throw", async () => {
    const test = await makeTestDef();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "ask_clarification", input: {} }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    await expect(simulator.decide({ test, transcript: [] })).rejects.toThrow(
      /parts=\[tool_use\(name=ask_clarification\)\]/,
    );
  });

  test("empty content with non-end_turn stop reasons still throws", async () => {
    // Implicit-end recovery is scoped to the exact end_turn shape. Other
    // stop reasons (max_tokens, refusal, tool_use without payload, …)
    // represent genuine failures we want operators to see, not silently
    // swallow as "the model wanted to end".
    const test = await makeTestDef();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ content: [], stop_reason: "max_tokens" }), {
        status: 200,
      })) as unknown as typeof fetch;

    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    await expect(simulator.decide({ test, transcript: [] })).rejects.toThrow(
      SimulatorParseError,
    );
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

  test("decide returns the simulator's allow confirmation", async () => {
    // GIVEN the simulator answers a pending confirmation with `allow`
    const test = await makeTestDef();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "respond_to_confirmation",
              input: { decision: "allow", reason: "matches the SPEC goal" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    // WHEN it decides with a pending tool confirmation
    const decision = await simulator.decide({
      test,
      transcript: [],
      pendingConfirmation: { toolName: "Bash", input: { cmd: "ls" } },
    });

    // THEN the decision confirms allow and carries the model's reason
    expect(decision).toEqual({
      action: "confirm",
      decision: "allow",
      reason: "matches the SPEC goal",
    });
  });

  test("decide returns the simulator's deny confirmation", async () => {
    // GIVEN the simulator answers a pending confirmation with `deny`
    const test = await makeTestDef();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "respond_to_confirmation",
              input: { decision: "deny" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    // WHEN it decides with a pending tool confirmation
    const decision = await simulator.decide({
      test,
      transcript: [],
      pendingConfirmation: { toolName: "Bash", input: { cmd: "rm -rf /" } },
    });

    // THEN the decision denies and omits the optional reason
    expect(decision).toEqual({
      action: "confirm",
      decision: "deny",
      reason: undefined,
    });
  });

  test("decide forces the respond_to_confirmation tool and describes a pending confirmation", async () => {
    // GIVEN a confirmation request carrying tool details and a risk reason
    const test = await makeTestDef();
    let requestBody:
      | {
          tools?: Array<{ name?: string }>;
          tool_choice?: { type?: string; name?: string };
          messages?: Array<{ role: string; content: string }>;
        }
      | undefined;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "respond_to_confirmation",
              input: { decision: "allow" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    // WHEN it decides with a pending tool confirmation
    await simulator.decide({
      test,
      transcript: [],
      pendingConfirmation: {
        toolName: "WriteFile",
        input: { path: "/etc/hosts" },
        riskLevel: "high",
        riskReason: "writes outside the workspace",
      },
    });

    // THEN the request forces the respond_to_confirmation tool
    expect(requestBody?.tools).toEqual([
      expect.objectContaining({ name: "respond_to_confirmation" }),
    ]);
    expect(requestBody?.tool_choice).toEqual({
      type: "tool",
      name: "respond_to_confirmation",
    });
    // AND the trailing user message describes the tool, input, and risk
    const lastMessage = requestBody?.messages?.at(-1);
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.content).toContain("WriteFile");
    expect(lastMessage?.content).toContain("/etc/hosts");
    expect(lastMessage?.content).toContain("writes outside the workspace");
  });

  test("decide throws SimulatorParseError when a pending confirmation yields no decision", async () => {
    // GIVEN the model replies without calling respond_to_confirmation
    const test = await makeTestDef();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "I am not sure" }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const simulator = new UserSimulator({ apiKey: "test-key", maxTurns: 5 });

    // WHEN / THEN deciding the confirmation surfaces a structured parse error
    await expect(
      simulator.decide({
        test,
        transcript: [],
        pendingConfirmation: { toolName: "Bash", input: {} },
      }),
    ).rejects.toThrow(SimulatorParseError);
  });
});

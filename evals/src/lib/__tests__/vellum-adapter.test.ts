import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import { VellumAgent, normalizeVellumEventStream } from "../adapters/vellum";
import type { Profile } from "../profile";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
  SpawnedProcess,
} from "../runtime/command-runner";

// Adapter computes the repo root the same way: four `..`s up from its own
// file. `__tests__/` sits at the same depth as `adapters/` so the same
// expression yields the same path here.
const ADAPTER_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

function lines(values: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

class FakeProcess implements SpawnedProcess {
  pid = 123;
  killed = false;
  stdout = lines(['{"message":{"type":"assistant_text_delta","text":"hi"}}\n']);
  stderr = lines([]);

  async wait(): Promise<number> {
    return 0;
  }

  kill(): void {
    this.killed = true;
  }
}

interface RunCall {
  command: string;
  args: string[];
  opts?: RunOptions;
}

class FakeRunner implements CommandRunner {
  readonly runs: RunCall[] = [];
  readonly spawns: Array<{ command: string; args: string[] }> = [];
  readonly process = new FakeProcess();

  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    this.runs.push({ command, args, opts });
    const script = args.at(-1) ?? "";
    const stdout = script.includes("assistant conversations new")
      ? "Created conversation: New Conversation (conv-123), conversation key: generated-key-123, seeded 2 messages\n"
      : "ok";
    return { exitCode: 0, stdout, stderr: "" };
  }

  spawn(command: string, args: string[]): SpawnedProcess {
    this.spawns.push({ command, args });
    return this.process;
  }
}

const profile: Profile = {
  id: "vellum-bare",
  manifest: {
    species: "vellum",
    setup: ["assistant plugins install simple-memory"],
  },
  workspaceDir: "/profiles/vellum-bare/workspace",
};

describe("VellumAgent", () => {
  test("hatches a fresh docker assistant, applies the jail externally, runs setup, and subscribes to events", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      cliCommand: "vellum",
      profile,
      testId: "timeline-recall",
      runId: "eval-run-1",
    });

    await agent.hatch();

    expect(agent.id).toBe("eval-run-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-run-1");
    // Recording sidecar adds docker build + run calls
    expect(runner.runs[0]).toEqual({
      command: "vellum",
      args: [
        "hatch",
        "vellum",
        "--remote",
        "docker",
        "--source",
        ADAPTER_REPO_ROOT,
        "--name",
        "eval-run-1",
      ],
      // logPath routes hatch's stdout/stderr into the per-run
      // subprocess-hatch.log file so the report UI can render it
      // even when the run failed before assistant_complete fired.
      // logStep tags every line in that file with `[hatch]` so the
      // inline UI renderer can pick out which subprocess each line
      // belongs to (matches the format the test runner log uses).
      opts: {
        env: {},
        logPath: expect.stringMatching(/\/subprocess-hatch\.log$/),
        logStep: "hatch",
      },
    });
    expect(runner.runs[1]).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-1-assistant-egress-jail"],
    });
    // Build command
    expect(runner.runs[2].command).toBe("docker");
    expect(runner.runs[2].args[0]).toBe("build");
    expect(runner.runs[2].args[1]).toBe("-t");
    expect(runner.runs[2].args[2]).toBe("vellum-evals-recording-jail:local");
    // Run command (detached recording jail)
    expect(runner.runs[3].command).toBe("docker");
    expect(runner.runs[3].args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "eval-run-1-assistant-egress-jail",
      "--network",
      "container:eval-run-1-assistant",
    ]);
    expect(runner.runs[3].args).toContain("--cap-add");
    expect(runner.runs[3].args).toContain("NET_ADMIN");
    expect(runner.runs[3].args).toContain("evals.vellum.ai/egress-recording=1");
    // Setup command — also gets a per-step subprocess-setup-N.log
    expect(runner.runs[4]).toEqual({
      command: "vellum",
      args: [
        "exec",
        "eval-run-1",
        "--",
        "sh",
        "-lc",
        "assistant plugins install simple-memory",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-setup-1\.log$/),
        logStep: "setup-1",
      },
    });
    expect(runner.spawns).toEqual([]);

    const events = [];
    for await (const event of agent.events()) events.push(event);
    expect(runner.spawns).toEqual([
      {
        command: "vellum",
        args: [
          "events",
          "eval-run-1",
          "--conversation-key",
          "evals:timeline-recall:eval-run-1",
          "--json",
        ],
      },
    ]);
    expect(events).toEqual([
      { message: { type: "assistant_text_delta", text: "hi" } },
    ]);
  });

  test("forwards LLM provider API keys from process env into the hatch subprocess", async () => {
    const runner = new FakeRunner();
    // Mix recognized provider vars (should be forwarded), an empty provider
    // var (should be dropped, not propagated as ""), and an unrelated var
    // (should be ignored — the adapter only forwards the explicit allowlist).
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-env",
      processEnv: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-openai-test",
        FIREWORKS_API_KEY: "",
        SHELL: "/bin/zsh",
      },
    });

    await agent.hatch();

    const hatchCall = runner.runs.find((r) => r.args[0] === "hatch");
    expect(hatchCall).toBeDefined();
    expect(hatchCall?.opts?.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
    });
  });

  test("forwards an empty env to hatch when no provider keys are set", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-noenv",
      processEnv: { PATH: "/usr/bin" },
    });

    await agent.hatch();

    const hatchCall = runner.runs.find((r) => r.args[0] === "hatch");
    expect(hatchCall?.opts?.env).toEqual({});
  });

  test("seeds deterministic conversation history through the adapter bridge", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-seed",
    });

    await agent.hatch();
    await agent.runSetupCommand({
      type: "seed-conversation",
      messages: [
        { role: "user", content: "remember this exact note" },
        { role: "assistant", content: "noted" },
      ],
    });

    const copyRun = runner.runs.at(-2)!;
    expect(copyRun.command).toBe("docker");
    expect(copyRun.args[0]).toBe("cp");
    expect(copyRun.args[2]).toBe(
      "eval-run-seed-assistant:/tmp/eval-run-seed-conversation-seed.json",
    );

    const seedRun = runner.runs.at(-1)!;
    expect(seedRun.command).toBe("vellum");
    expect(seedRun.args.slice(0, 4)).toEqual([
      "exec",
      "eval-run-seed",
      "--",
      "sh",
    ]);
    expect(seedRun.args[4]).toBe("-lc");
    expect(seedRun.args[5]).toContain("set -e");
    expect(seedRun.args[5]).toContain("assistant conversations new");
    expect(seedRun.args[5]).not.toContain("--conversation-key");
    expect(seedRun.args[5]).toContain(
      "--content-file '/tmp/eval-run-seed-conversation-seed.json'",
    );
    expect(seedRun.args[5]).toContain(
      "rm -f '/tmp/eval-run-seed-conversation-seed.json'",
    );
    expect(seedRun.args[5]).not.toContain("remember this exact note");
    expect(seedRun.args[5]).not.toContain("noted");
    expect(agent.conversationKey).toBe("generated-key-123");
  });

  test("sends through the same conversation key and shuts down resources", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-2",
    });

    await agent.hatch();
    agent.events();
    await agent.send({ content: "hello" });
    await agent.shutdown();

    expect(runner.runs.map((r) => [r.command, ...r.args]).slice(-3)).toEqual([
      [
        "vellum",
        "message",
        "eval-run-2",
        "--conversation-key",
        "evals:timeline-recall:eval-run-2",
        "hello",
      ],
      ["docker", "rm", "-f", "eval-run-2-assistant-egress-jail"],
      ["vellum", "retire", "eval-run-2"],
    ]);
    expect(runner.process.killed).toBe(true);
  });

  test("captures forensics for every sibling container AND retires the run after any hatch failure", async () => {
    // PR r3 trade-off: the previous gate (`if (hatchStarted)`) skipped
    // forensics + retire whenever `vellum hatch` exited non-zero — the
    // exact failure mode operators want diagnostics for (port collision,
    // OOM, image build failure, …). We trade the theoretical "name
    // collision could belong to a parallel run" safety for the much
    // more common "show me what state my failed hatch left the
    // containers in". Run uniqueness is preserved via the 14-digit
    // timestamp suffix in `runId` and the pre-flight orphan-cleanup
    // sweep at the top of `evals run`.
    class FailingRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        if (args[0] === "hatch") {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "docker: Error response from daemon: bind for 0.0.0.0:20100 failed: port is already allocated",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const runner = new FailingRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-vellum-bare-x-20260524160000",
    });

    await expect(agent.hatch()).rejects.toThrow("port is already allocated");
    const sequence = runner.runs.map((r) => [r.command, ...r.args]);

    // Hatch attempted exactly once.
    const hatchCalls = sequence.filter(
      (parts) => parts[0] === "vellum" && parts[1] === "hatch",
    );
    expect(hatchCalls).toHaveLength(1);

    // Forensics captured for ALL three sibling containers — not just
    // the assistant. The gateway inspect is the actionable artifact
    // for port-collision failures.
    const inspectCalls = sequence.filter(
      (parts) => parts[0] === "docker" && parts[1] === "inspect",
    );
    expect(inspectCalls.map((c) => c[2])).toEqual([
      "eval-vellum-bare-x-20260524160000-assistant",
      "eval-vellum-bare-x-20260524160000-gateway",
      "eval-vellum-bare-x-20260524160000-credential-executor",
    ]);
    const logCalls = sequence.filter(
      (parts) =>
        parts[0] === "docker" &&
        parts[1] === "logs" &&
        parts[2] === "--tail" &&
        parts[3] === "200",
    );
    expect(logCalls.map((c) => c[4])).toEqual([
      "eval-vellum-bare-x-20260524160000-assistant",
      "eval-vellum-bare-x-20260524160000-gateway",
      "eval-vellum-bare-x-20260524160000-credential-executor",
    ]);

    // Retire fired exactly once, at the end, to clean up whatever
    // partial state the failed hatch left behind. Without it the next
    // run hits the same port collision.
    const retireCalls = sequence.filter(
      (parts) => parts[0] === "vellum" && parts[1] === "retire",
    );
    expect(retireCalls).toHaveLength(1);
    expect(retireCalls[0][2]).toBe("eval-vellum-bare-x-20260524160000");
  });
});

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

function source(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe("normalizeVellumEventStream", () => {
  test("passes through assistant_text_delta events unchanged", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "assistant_text_delta", text: "hello" } },
          { message: { type: "assistant_text_delta", text: " world" } },
        ]),
      ),
    );
    expect(out).toEqual([
      { message: { type: "assistant_text_delta", text: "hello" } },
      { message: { type: "assistant_text_delta", text: " world" } },
    ]);
  });

  test("passes through message_chunk events unchanged", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([{ message: { type: "message_chunk", chunk: "hi" } }]),
      ),
    );
    expect(out).toEqual([{ message: { type: "message_chunk", chunk: "hi" } }]);
  });

  test("strips text on user_message_echo (the iter-2 echo bug)", async () => {
    // The exact failure mode from the iter-2 timeline-recall eval: the
    // Vellum daemon broadcasts `user_message_echo` with the user's own
    // outbound on `message.text`. A naive `text ?? chunk` in the runner
    // captured it as the assistant's first reply, 72 ms after send.
    // Adapter-level normalization must clear `text` so it can never
    // land as transcript.
    const out = await collect(
      normalizeVellumEventStream(
        source([
          {
            message: {
              type: "user_message_echo",
              text: "What date did I mention my partner's peanut allergy?",
            },
          },
        ]),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message.type).toBe("user_message_echo");
    expect(out[0]?.message.text).toBeUndefined();
    expect(out[0]?.message.chunk).toBeUndefined();
  });

  test("strips text/chunk on tool, thinking, error, complete, usage events but preserves them on the stream", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "tool_use_start", toolName: "shell" } },
          { message: { type: "tool_input_delta", content: '{"cmd": "ls' } },
          { message: { type: "tool_output_chunk", chunk: "file.txt" } },
          { message: { type: "assistant_thinking_delta", thinking: "hmm" } },
          { message: { type: "error", message: "boom" } },
          { message: { type: "message_complete" } },
          {
            message: {
              type: "assistant_usage",
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        ]),
      ),
    );
    expect(out).toHaveLength(7);
    for (const event of out) {
      expect(event.message.text).toBeUndefined();
      expect(event.message.chunk).toBeUndefined();
    }
    // Other fields preserved so the artifact log + metrics layer can
    // still inspect tool args / thinking / usage records.
    expect(out[0]?.message.toolName).toBe("shell");
    expect(out[3]?.message.thinking).toBe("hmm");
    expect(out[6]?.message.input_tokens).toBe(100);
  });

  test("strips when `type` field is missing or non-string (defensive — unknown shapes shouldn't slip through as transcript)", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "", text: "nope" } },
          // @ts-expect-error -- intentionally malformed
          { message: { text: "also nope" } },
        ]),
      ),
    );
    expect(out[0]?.message.text).toBeUndefined();
    expect(out[1]?.message.text).toBeUndefined();
  });
});

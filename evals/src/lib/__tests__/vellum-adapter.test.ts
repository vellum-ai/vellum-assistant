import { describe, expect, test } from "bun:test";

import { VellumAgent } from "../adapters/vellum";
import type { Profile } from "../profile";
import type {
  CommandResult,
  CommandRunner,
  SpawnedProcess,
} from "../runtime/command-runner";

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

class FakeRunner implements CommandRunner {
  readonly runs: Array<{ command: string; args: string[] }> = [];
  readonly spawns: Array<{ command: string; args: string[] }> = [];
  readonly process = new FakeProcess();

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runs.push({ command, args });
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
    expect(runner.runs.map((r) => [r.command, ...r.args])).toEqual([
      [
        "vellum",
        "hatch",
        "vellum",
        "--remote",
        "docker",
        "--name",
        "eval-run-1",
      ],
      ["docker", "rm", "-f", "eval-run-1-assistant-egress-jail"],
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        "--name",
        "eval-run-1-assistant-egress-jail",
        "--network",
        "container:eval-run-1-assistant",
      ]),
      [
        "vellum",
        "exec",
        "eval-run-1",
        "--",
        "sh",
        "-lc",
        "assistant plugins install simple-memory",
      ],
    ]);
    expect(runner.runs[2].args).toContain("--cap-add");
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
    expect(seedRun.args[5]).toContain("trap cleanup EXIT");
    expect(seedRun.args[5]).toContain("assistant conversations new");
    expect(seedRun.args[5]).not.toContain("--conversation-key");
    expect(seedRun.args[5]).toContain('--content-file "$seed_file"');
    expect(seedRun.args[5]).toContain("remember this exact note");
    expect(seedRun.args[5]).toContain("noted");
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

  test("does not retire a pre-existing assistant if hatch fails before creation succeeds", async () => {
    class FailingRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
      ): Promise<CommandResult> {
        this.runs.push({ command, args });
        if (args[0] === "hatch") {
          return { exitCode: 1, stdout: "", stderr: "name already exists" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const runner = new FailingRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "preexisting",
    });

    await expect(agent.hatch()).rejects.toThrow("name already exists");
    expect(runner.runs.map((r) => [r.command, ...r.args])).toEqual([
      [
        "vellum",
        "hatch",
        "vellum",
        "--remote",
        "docker",
        "--name",
        "preexisting",
      ],
    ]);
  });
});

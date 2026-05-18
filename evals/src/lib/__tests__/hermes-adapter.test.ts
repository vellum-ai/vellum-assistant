import { describe, expect, test } from "bun:test";

import { HermesAgent, DEFAULT_HERMES_IMAGE } from "../adapters/hermes";
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
  pid = 456;
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
    const stdout = script.includes("conversations new")
      ? "Created conversation: New Conversation (conv-456), conversation key: generated-hermes-key, seeded 2 messages\n"
      : "ok";
    return { exitCode: 0, stdout, stderr: "" };
  }

  spawn(command: string, args: string[]): SpawnedProcess {
    this.spawns.push({ command, args });
    return this.process;
  }
}

const profile: Profile = {
  id: "hermes-bare",
  manifest: {
    species: "hermes",
    setup: ["hermes plugins install simple-memory"],
  },
  workspaceDir: "/profiles/hermes-bare/workspace",
};

describe("HermesAgent", () => {
  test("starts a detached Hermes container, applies the jail, runs setup, and subscribes to events", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-1",
    });

    await agent.hatch();

    expect(agent.id).toBe("eval-hermes-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-hermes-1");

    // Pre-flight rm -f + docker run + jail apply + setup exec.
    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    expect(calls[0]).toEqual(["docker", "rm", "-f", "eval-hermes-1-hermes"]);
    expect(calls[1]).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "eval-hermes-1-hermes",
      "--label",
      "evals.vellum.ai/species=hermes",
      DEFAULT_HERMES_IMAGE,
    ]);
    expect(calls[2]).toContain("docker");
    expect(calls[2]).toContain("rm");
    expect(calls[2]).toContain("eval-hermes-1-hermes-egress-jail");
    expect(calls[3]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--rm",
        "--name",
        "eval-hermes-1-hermes-egress-jail",
        "--network",
        "container:eval-hermes-1-hermes",
      ]),
    );
    expect(calls[3]).toContain("--cap-add");
    expect(calls[4]).toEqual([
      "docker",
      "exec",
      "eval-hermes-1-hermes",
      "sh",
      "-lc",
      "hermes plugins install simple-memory",
    ]);
    expect(runner.spawns).toEqual([]);

    const events = [];
    for await (const event of agent.events()) events.push(event);
    expect(runner.spawns).toEqual([
      {
        command: "docker",
        args: [
          "exec",
          "eval-hermes-1-hermes",
          "hermes",
          "events",
          "--conversation-key",
          "evals:timeline-recall:eval-hermes-1",
          "--json",
        ],
      },
    ]);
    expect(events).toEqual([
      { message: { type: "assistant_text_delta", text: "hi" } },
    ]);
  });

  test("honors a custom docker image and in-container CLI command", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-custom",
      dockerImage: "nousresearch/hermes:v0.42",
      cliCommand: "hermesctl",
    });

    await agent.hatch();
    await agent.send({ content: "hello hermes" });

    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    expect(calls[1]).toContain("nousresearch/hermes:v0.42");
    expect(calls.at(-1)).toEqual([
      "docker",
      "exec",
      "eval-hermes-custom-hermes",
      "hermesctl",
      "message",
      "--conversation-key",
      "evals:timeline-recall:eval-hermes-custom",
      "hello hermes",
    ]);
  });

  test("seeds a deterministic conversation history through docker cp + exec", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-seed",
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
      "eval-hermes-seed-hermes:/tmp/eval-hermes-seed-conversation-seed.json",
    );

    const seedRun = runner.runs.at(-1)!;
    expect(seedRun.command).toBe("docker");
    expect(seedRun.args.slice(0, 4)).toEqual([
      "exec",
      "eval-hermes-seed-hermes",
      "sh",
      "-lc",
    ]);
    expect(seedRun.args[4]).toContain("set -e");
    expect(seedRun.args[4]).toContain("hermes conversations new");
    expect(seedRun.args[4]).toContain(
      "--content-file '/tmp/eval-hermes-seed-conversation-seed.json'",
    );
    expect(seedRun.args[4]).toContain(
      "rm -f '/tmp/eval-hermes-seed-conversation-seed.json'",
    );
    // Message bodies must NOT leak through the seed payload via the shell.
    expect(seedRun.args[4]).not.toContain("remember this exact note");
    expect(seedRun.args[4]).not.toContain("noted");
    expect(agent.conversationKey).toBe("generated-hermes-key");
  });

  test("sends through the running container and tears down on shutdown", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-2",
    });

    await agent.hatch();
    agent.events();
    await agent.send({ content: "hello" });
    await agent.shutdown();

    expect(runner.runs.map((r) => [r.command, ...r.args]).slice(-3)).toEqual([
      [
        "docker",
        "exec",
        "eval-hermes-2-hermes",
        "hermes",
        "message",
        "--conversation-key",
        "evals:timeline-recall:eval-hermes-2",
        "hello",
      ],
      ["docker", "rm", "-f", "eval-hermes-2-hermes-egress-jail"],
      ["docker", "rm", "-f", "eval-hermes-2-hermes"],
    ]);
    expect(runner.process.killed).toBe(true);
  });

  test("does not retire the container if hatch fails before container creation succeeds", async () => {
    class FailingRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
      ): Promise<CommandResult> {
        this.runs.push({ command, args });
        if (command === "docker" && args[0] === "run" && args.includes("-d")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Unable to find image 'nousresearch/hermes:latest'",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const runner = new FailingRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "image-missing",
    });

    await expect(agent.hatch()).rejects.toThrow(
      "Unable to find image 'nousresearch/hermes:latest'",
    );
    // Pre-flight rm -f always runs; then the failed `docker run -d` aborts
    // hatch without firing a follow-up rm -f for the container that never
    // existed.
    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    expect(calls).toEqual([
      ["docker", "rm", "-f", "image-missing-hermes"],
      [
        "docker",
        "run",
        "-d",
        "--name",
        "image-missing-hermes",
        "--label",
        "evals.vellum.ai/species=hermes",
        DEFAULT_HERMES_IMAGE,
      ],
    ]);
  });

  test("refuses to hatch a non-hermes profile", async () => {
    const runner = new FakeRunner();
    const wrongProfile: Profile = {
      id: "vellum-bare",
      manifest: { species: "vellum" },
      workspaceDir: "/profiles/vellum-bare/workspace",
    };
    const agent = new HermesAgent({
      runner,
      profile: wrongProfile,
      testId: "timeline-recall",
      runId: "eval-mismatch",
    });

    await expect(agent.hatch()).rejects.toThrow(
      "HermesAgent can only run species=hermes profiles",
    );
  });
});

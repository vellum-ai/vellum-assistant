import { describe, expect, test } from "bun:test";

import {
  HermesAgent,
  DEFAULT_HERMES_IMAGE,
  EXEC_PATH,
  selectProviderEnvFlags,
} from "../adapters/hermes";
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
      processEnv: {}, // deterministic: no provider env flags
    });

    await agent.hatch();

    expect(agent.id).toBe("eval-hermes-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-hermes-1");

    // Pre-flight rm -f + docker run (image + daemon args) + jail apply + setup exec.
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
      "gateway",
      "run",
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
      "--env",
      `PATH=${EXEC_PATH}`,
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
          "--env",
          `PATH=${EXEC_PATH}`,
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

  test("honors a custom docker image, daemon args, and in-container CLI command", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-custom",
      dockerImage: "nousresearch/hermes-agent:v0.42",
      cliCommand: "hermesctl",
      daemonArgs: ["serve", "--port", "1234"],
      processEnv: {},
    });

    await agent.hatch();
    await agent.send({ content: "hello hermes" });

    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    // Image + custom daemonArgs land at the tail of the `docker run` invocation.
    expect(calls[1].slice(-4)).toEqual([
      "nousresearch/hermes-agent:v0.42",
      "serve",
      "--port",
      "1234",
    ]);
    expect(calls.at(-1)).toEqual([
      "docker",
      "exec",
      "--env",
      `PATH=${EXEC_PATH}`,
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
      processEnv: {},
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
    expect(seedRun.args.slice(0, 6)).toEqual([
      "exec",
      "--env",
      `PATH=${EXEC_PATH}`,
      "eval-hermes-seed-hermes",
      "sh",
      "-lc",
    ]);
    const script = seedRun.args[6]!;
    expect(script).toContain("set -e");
    expect(script).toContain("hermes conversations new");
    expect(script).toContain(
      "--content-file '/tmp/eval-hermes-seed-conversation-seed.json'",
    );
    expect(script).toContain(
      "rm -f '/tmp/eval-hermes-seed-conversation-seed.json'",
    );
    // Message bodies must NOT leak through the seed payload via the shell.
    expect(script).not.toContain("remember this exact note");
    expect(script).not.toContain("noted");
    expect(agent.conversationKey).toBe("generated-hermes-key");
  });

  test("sends through the running container and tears down on shutdown", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-2",
      processEnv: {},
    });

    await agent.hatch();
    agent.events();
    await agent.send({ content: "hello" });
    await agent.shutdown();

    expect(runner.runs.map((r) => [r.command, ...r.args]).slice(-3)).toEqual([
      [
        "docker",
        "exec",
        "--env",
        `PATH=${EXEC_PATH}`,
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
            stderr: "Unable to find image 'nousresearch/hermes-agent:latest'",
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
      processEnv: {},
    });

    await expect(agent.hatch()).rejects.toThrow(
      "Unable to find image 'nousresearch/hermes-agent:latest'",
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
        "gateway",
        "run",
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
      processEnv: {},
    });

    await expect(agent.hatch()).rejects.toThrow(
      "HermesAgent can only run species=hermes profiles",
    );
  });

  test("forwards configured LLM provider env vars into the container via `-e <NAME>`", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-env",
      processEnv: {
        ANTHROPIC_API_KEY: "anthropic-test-value",
        OPENAI_API_KEY: "openai-test-value",
        // Not in the default forward list — must not leak through.
        UNRELATED_SECRET: "ignored",
      },
    });

    await agent.hatch();

    const dockerRun = runner.runs.find(
      (r) =>
        r.command === "docker" && r.args[0] === "run" && r.args[1] === "-d",
    )!;
    // `-e NAME` is emitted by name only (docker reads the value from its
    // own env, inherited from the eval process). Values must NOT appear on
    // the command line.
    expect(dockerRun.args).toContain("-e");
    expect(dockerRun.args).toContain("ANTHROPIC_API_KEY");
    expect(dockerRun.args).toContain("OPENAI_API_KEY");
    expect(dockerRun.args).not.toContain("UNRELATED_SECRET");
    expect(dockerRun.args.join(" ")).not.toContain("anthropic-test-value");
    expect(dockerRun.args.join(" ")).not.toContain("openai-test-value");

    // The image still sits between the env flags and the daemon args.
    const imageIdx = dockerRun.args.indexOf(DEFAULT_HERMES_IMAGE);
    expect(imageIdx).toBeGreaterThan(dockerRun.args.lastIndexOf("-e"));
    expect(dockerRun.args.slice(imageIdx + 1)).toEqual(["gateway", "run"]);
  });

  test("selectProviderEnvFlags emits -e flags only for present, allow-listed vars", () => {
    expect(
      selectProviderEnvFlags({
        ANTHROPIC_API_KEY: "present",
        OPENAI_API_KEY: undefined,
        GOOGLE_API_KEY: "",
        GEMINI_API_KEY: "present",
        SOMETHING_ELSE: "present",
      }),
    ).toEqual(["-e", "ANTHROPIC_API_KEY", "-e", "GEMINI_API_KEY"]);

    // Empty env → no flags.
    expect(selectProviderEnvFlags({})).toEqual([]);

    // Custom allow-list overrides the default set.
    expect(
      selectProviderEnvFlags(
        { CUSTOM_KEY: "v", ANTHROPIC_API_KEY: "ignored" },
        ["CUSTOM_KEY"],
      ),
    ).toEqual(["-e", "CUSTOM_KEY"]);
  });
});

import { describe, expect, test } from "bun:test";

import { VellumAdapter } from "../adapters/vellum";
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
  readonly runs: Array<{
    command: string;
    args: string[];
    env?: Record<string, string>;
  }> = [];
  readonly spawns: Array<{ command: string; args: string[] }> = [];
  readonly process = new FakeProcess();

  async run(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.runs.push({ command, args, env: opts?.env });
    return { exitCode: 0, stdout: "ok", stderr: "" };
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

describe("VellumAdapter", () => {
  test("prepares the jail, hatches a fresh docker assistant, runs setup, and subscribes to events", async () => {
    const runner = new FakeRunner();
    const adapter = new VellumAdapter({ runner, cliCommand: "vellum" });

    const agent = await adapter.spawn({
      profile,
      testId: "timeline-recall",
      runId: "eval-run-1",
    });

    expect(agent.id).toBe("eval-run-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-run-1");
    expect(runner.runs.map((r) => [r.command, ...r.args])).toEqual([
      ["docker", "rm", "-f", "eval-run-1-egress-proxy"],
      ["docker", "network", "rm", "eval-run-1-net"],
      ["docker", "network", "create", "--internal", "eval-run-1-net"],
      expect.arrayContaining([
        "docker",
        "run",
        "-d",
        "--name",
        "eval-run-1-egress-proxy",
      ]),
      [
        "docker",
        "network",
        "connect",
        "--alias",
        "eval-run-1-egress-proxy",
        "eval-run-1-net",
        "eval-run-1-egress-proxy",
      ],
      [
        "vellum",
        "hatch",
        "vellum",
        "--remote",
        "docker",
        "--name",
        "eval-run-1",
      ],
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

    expect(runner.runs[5].env).toMatchObject({
      VELLUM_ASSISTANT_HTTPS_PROXY: "http://eval-run-1-egress-proxy:8080",
      VELLUM_DOCKER_NETWORK_PRECREATED: "1",
    });
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

    const events = [];
    for await (const event of agent.events()) events.push(event);
    expect(events).toEqual([
      { message: { type: "assistant_text_delta", text: "hi" } },
    ]);
  });

  test("sends through the same conversation key and shuts down resources", async () => {
    const runner = new FakeRunner();
    const adapter = new VellumAdapter({ runner });
    const agent = await adapter.spawn({
      profile,
      testId: "timeline-recall",
      runId: "eval-run-2",
    });

    await agent.send({ content: "hello" });
    await agent.shutdown();

    expect(runner.runs.map((r) => [r.command, ...r.args]).slice(-4)).toEqual([
      [
        "vellum",
        "message",
        "eval-run-2",
        "--conversation-key",
        "evals:timeline-recall:eval-run-2",
        "hello",
      ],
      ["docker", "rm", "-f", "eval-run-2-egress-proxy"],
      ["docker", "network", "rm", "eval-run-2-net"],
      ["vellum", "retire", "eval-run-2"],
    ]);
    expect(runner.process.killed).toBe(true);
  });
});

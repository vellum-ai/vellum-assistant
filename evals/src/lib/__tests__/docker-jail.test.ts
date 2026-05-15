import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_ALLOW_HOSTS,
  applyDockerEgressJail,
  dockerEgressJailContainerName,
  vellumDockerAssistantContainer,
} from "../egress/docker-jail";
import type {
  CommandResult,
  CommandRunner,
  SpawnedProcess,
} from "../runtime/command-runner";

class FakeRunner implements CommandRunner {
  readonly runs: Array<{ command: string; args: string[] }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runs.push({ command, args });
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }

  spawn(): SpawnedProcess {
    throw new Error("spawn not used");
  }
}

describe("docker egress jail", () => {
  test("derives deterministic Docker names from the assistant container", () => {
    expect(vellumDockerAssistantContainer("eval-vellum-bare")).toBe(
      "eval-vellum-bare-assistant",
    );
    expect(dockerEgressJailContainerName("eval-vellum-bare-assistant")).toBe(
      "eval-vellum-bare-assistant-egress-jail",
    );
  });

  test("applies policy from a sidecar in the target container namespace", async () => {
    const runner = new FakeRunner();

    const jail = await applyDockerEgressJail(runner, {
      containerName: "eval-run-1-assistant",
      allowHosts: ["api.anthropic.com"],
      jailImage: "jail-image@sha256:abc",
      scriptPath: "/workspace/evals/docker-egress-jail.sh",
    });

    expect(runner.runs).toEqual(
      [
        ["docker", "rm", "-f", "eval-run-1-assistant-egress-jail"],
        [
          "docker",
          "run",
          "--rm",
          "--name",
          "eval-run-1-assistant-egress-jail",
          "--network",
          "container:eval-run-1-assistant",
          "--cap-add",
          "NET_ADMIN",
          "--label",
          "evals.vellum.ai/egress-jail=1",
          "-e",
          "ALLOW_HOSTS=api.anthropic.com",
          "-v",
          "/workspace/evals/docker-egress-jail.sh:/evals/apply-egress-jail.sh:ro",
          "jail-image@sha256:abc",
          "sh",
          "/evals/apply-egress-jail.sh",
        ],
      ].map(([command, ...args]) => ({ command, args })),
    );

    await jail.stop();
    expect(runner.runs.at(-1)).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-1-assistant-egress-jail"],
    });
  });

  test("defaults to the shared model-provider allowlist", async () => {
    const runner = new FakeRunner();

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-2-assistant",
      scriptPath: "/workspace/evals/docker-egress-jail.sh",
    });

    expect(DEFAULT_MODEL_ALLOW_HOSTS).toContain("api.anthropic.com");
    expect(runner.runs[1].args).toContain(
      `ALLOW_HOSTS=${DEFAULT_MODEL_ALLOW_HOSTS.join(",")}`,
    );
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

  test("always starts the recording mitm sidecar and reads NDJSON usage records", async () => {
    // Recording is the only egress-jail mode: every eval run produces
    // ground-truth usage out of the box (PR #31348 follow-up). The
    // assertions below pin the exact `docker run` shape so the mitm
    // sidecar can never silently regress to a non-recording variant.
    const runner = new FakeRunner();
    const dir = `.runs/test-recording-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "egress-usage.ndjson"),
      '{"provider":"anthropic","model":"claude-haiku-4-5","input_tokens":10,"output_tokens":5}\n',
    );

    const jail = await applyDockerEgressJail(runner, {
      containerName: "eval-run-3-assistant",
      allowHosts: ["api.anthropic.com"],
      recordingDir: dir,
      recordingImage: "recording:local",
      recordingDockerfileDir: "/workspace/evals/recording",
    });

    expect(runner.runs[0]).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-3-assistant-egress-jail"],
    });
    expect(runner.runs[1]).toEqual({
      command: "docker",
      args: ["build", "-t", "recording:local", "/workspace/evals/recording"],
    });
    expect(runner.runs[2]?.args).toContain("-d");
    expect(runner.runs[2]?.args).toContain(
      "evals.vellum.ai/egress-recording=1",
    );
    expect(runner.runs[2]?.args).toContain("ALLOW_HOSTS=api.anthropic.com");
    // recordingDir gets resolved to absolute path in docker-jail
    const resolvedDir = resolve(dir);
    const mountArg = runner.runs[2]?.args.find((arg) =>
      arg?.includes(":/recording"),
    );
    expect(mountArg).toBe(`${resolvedDir}:/recording`);

    await expect(jail.readUsageRecords()).resolves.toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        input_tokens: 10,
        output_tokens: 5,
      },
    ]);

    await jail.stop();
    expect(runner.runs.at(-1)).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-3-assistant-egress-jail"],
    });
  });

  test("defaults to the shared model-provider allowlist", async () => {
    const runner = new FakeRunner();
    const dir = `.runs/test-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-2-assistant",
      recordingDir: dir,
    });

    expect(DEFAULT_MODEL_ALLOW_HOSTS).toContain("api.anthropic.com");
    // runs[0] is the pre-clean `rm -f`; runs[1] is the recording image
    // build; runs[2] is the `docker run -d` that wires up ALLOW_HOSTS.
    expect(runner.runs[2]?.args).toContain(
      `ALLOW_HOSTS=${DEFAULT_MODEL_ALLOW_HOSTS.join(",")}`,
    );
  });
});

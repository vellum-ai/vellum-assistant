import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ALLOW_HOSTS,
  DEFAULT_INFRA_ALLOW_HOSTS,
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

  test("defaults to the combined model+infra allowlist", async () => {
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
      `ALLOW_HOSTS=${DEFAULT_ALLOW_HOSTS.join(",")}`,
    );
  });

  test("default allowlist exposes the plugin-install hosts used by simple-memory setup", () => {
    // `assistant plugins install <name>` calls api.github.com for the
    // directory listing, then follows each entry's download_url which
    // points at raw.githubusercontent.com. Both must be reachable from
    // inside the jailed assistant container.
    expect(DEFAULT_INFRA_ALLOW_HOSTS).toContain("api.github.com");
    expect(DEFAULT_INFRA_ALLOW_HOSTS).toContain("raw.githubusercontent.com");
    expect(DEFAULT_ALLOW_HOSTS).toContain("api.github.com");
    expect(DEFAULT_ALLOW_HOSTS).toContain("raw.githubusercontent.com");
  });

  test("default allowlist covers every vellum platform environment seed", () => {
    // Mirror of cli/src/lib/environments/seeds.ts. If a new environment
    // ships, the allowlist needs to track it or that environment's eval
    // runs silently lose platform reachability.
    for (const host of [
      "platform.vellum.ai",
      "staging-platform.vellum.ai",
      "dev-platform.vellum.ai",
      "test-platform.vellum.ai",
    ]) {
      expect(DEFAULT_ALLOW_HOSTS).toContain(host);
    }
  });

  test("DEFAULT_MODEL_ALLOW_HOSTS stays bounded to recognized model providers", () => {
    // The mitmproxy addon (addon.py) parses usage out of these hosts'
    // response bodies. Adding a non-model host here would either be
    // dead code in the addon or, worse, would trip its parser. New
    // infra hosts belong in DEFAULT_INFRA_ALLOW_HOSTS.
    expect(DEFAULT_MODEL_ALLOW_HOSTS.sort()).toEqual([
      "api.anthropic.com",
      "api.openai.com",
      "generativelanguage.googleapis.com",
    ]);
  });

  test("an explicit allowHosts override still wins over the default", async () => {
    const runner = new FakeRunner();
    const dir = `.runs/test-allowlist-override-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-3-assistant",
      recordingDir: dir,
      allowHosts: ["example.test"],
    });

    expect(runner.runs[2]?.args).toContain("ALLOW_HOSTS=example.test");
  });
});

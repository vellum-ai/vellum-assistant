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
    // Pre-stage the CA file so installRecordingCa's polling resolves
    // immediately. In production the recording sidecar's entrypoint
    // drops this file at boot; tests don't run that entrypoint, so
    // without this pre-stage waitForRecordingCa would spin the full
    // 10s timeout before each applyDockerEgressJail call.
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

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
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

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

  test("default infra allowlist excludes github hosts (mock-github handler catches them instead)", () => {
    // `assistant plugins install <name>` traffic to api.github.com and
    // raw.githubusercontent.com is intercepted by the recording
    // addon's mock-github handler when pluginFixturesDir is set on
    // applyDockerEgressJail. The NAT REDIRECT rule in
    // apply-recording-jail.sh bounces 443 traffic into mitmproxy
    // before the filter table sees the original GitHub destination,
    // so the egress allowlist doesn't need to include them. Adding
    // them back would turn the mock into a passthrough and silently
    // change behavior for evals that rely on hermetic plugin install.
    expect(DEFAULT_INFRA_ALLOW_HOSTS).not.toContain("api.github.com");
    expect(DEFAULT_INFRA_ALLOW_HOSTS).not.toContain(
      "raw.githubusercontent.com",
    );
    expect(DEFAULT_INFRA_ALLOW_HOSTS).not.toContain("codeload.github.com");
    expect(DEFAULT_ALLOW_HOSTS).not.toContain("api.github.com");
    expect(DEFAULT_ALLOW_HOSTS).not.toContain("raw.githubusercontent.com");
    expect(DEFAULT_ALLOW_HOSTS).not.toContain("codeload.github.com");
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
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-3-assistant",
      recordingDir: dir,
      allowHosts: ["example.test"],
    });

    expect(runner.runs[2]?.args).toContain("ALLOW_HOSTS=example.test");
  });

  test("mounts plugin fixtures dir + sets PLUGIN_FIXTURES_DIR env when configured", async () => {
    const runner = new FakeRunner();
    const dir = `.runs/test-fixtures-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    const fixturesDir = `.runs/test-fixtures-src-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(fixturesDir, { recursive: true });

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-fixtures-assistant",
      recordingDir: dir,
      pluginFixturesDir: fixturesDir,
    });

    const dockerRun = runner.runs[2];
    expect(dockerRun?.command).toBe("docker");
    // -v <abs-fixtures>:/fixtures:ro lands as a single arg pair.
    const fixturesMount = dockerRun?.args.find((arg) =>
      arg?.includes(":/fixtures:ro"),
    );
    expect(fixturesMount).toBe(`${resolve(fixturesDir)}:/fixtures:ro`);
    expect(dockerRun?.args).toContain("PLUGIN_FIXTURES_DIR=/fixtures");
  });

  test("omits plugin fixtures args when pluginFixturesDir is not provided", async () => {
    const runner = new FakeRunner();
    const dir = `.runs/test-no-fixtures-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-no-fixtures-assistant",
      recordingDir: dir,
    });

    const dockerRun = runner.runs[2];
    const fixturesMount = dockerRun?.args.find((arg) =>
      arg?.includes(":/fixtures"),
    );
    expect(fixturesMount).toBeUndefined();
    expect(dockerRun?.args).not.toContain("PLUGIN_FIXTURES_DIR=/fixtures");
  });

  test("installs the recording CA into the assistant container after the sidecar starts", async () => {
    const runner = new FakeRunner();
    const dir = `.runs/test-ca-install-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    await applyDockerEgressJail(runner, {
      containerName: "eval-run-ca-assistant",
      recordingDir: dir,
    });

    // runs[0..2] = rm / build / run. Then the CA install pair fires
    // — cp must precede update-ca-certificates or the exec sees a
    // trust store that doesn't know about the new CA.
    const cpRun = runner.runs[3];
    expect(cpRun?.command).toBe("docker");
    expect(cpRun?.args[0]).toBe("cp");
    expect(cpRun?.args[1]).toBe(resolve(dir, "mitmproxy-ca-cert.pem"));
    expect(cpRun?.args[2]).toBe(
      "eval-run-ca-assistant:/usr/local/share/ca-certificates/vellum-evals-mitmproxy.crt",
    );

    const updateRun = runner.runs[4];
    expect(updateRun?.command).toBe("docker");
    expect(updateRun?.args).toEqual([
      "exec",
      "eval-run-ca-assistant",
      "update-ca-certificates",
    ]);
  });
});

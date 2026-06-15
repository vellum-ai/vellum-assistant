import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ALLOW_HOSTS,
  DEFAULT_INFRA_ALLOW_HOSTS,
  DEFAULT_MODEL_ALLOW_HOSTS,
  applyDockerEgressJail,
  installRecordingCa,
  dockerEgressJailContainerName,
  dockerEgressJailNetworkName,
  findOpenHostPort,
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
  test("derives deterministic Docker names from the run id", () => {
    // GIVEN a run id
    // WHEN deriving the assistant, jail, and network names
    // THEN each is a deterministic suffix of the run id, so cleanup is
    // idempotent and debuggable across owner/attach modes.
    expect(vellumDockerAssistantContainer("eval-vellum-default")).toBe(
      "eval-vellum-default-assistant",
    );
    expect(dockerEgressJailContainerName("eval-vellum-default")).toBe(
      "eval-vellum-default-egress-jail",
    );
    expect(dockerEgressJailNetworkName("eval-vellum-default")).toBe(
      "eval-vellum-default-egress-net",
    );
  });

  test("findOpenHostPort resolves a usable TCP port", async () => {
    // GIVEN nothing
    // WHEN asking the kernel for an open port
    const port = await findOpenHostPort();
    // THEN it falls inside the ephemeral range the OS hands out for
    // bind-to-0, so the jail can publish it on behalf of its tenants.
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test("owner mode creates a network, publishes ports, and exposes the netns container + CA", async () => {
    // Owner mode is how the assistant runs: the jail owns a fresh
    // network namespace and is born with all rules + CA in place before
    // any tenant joins, eliminating the pre-jail connection window. The
    // assertions pin the exact `docker` call shape so this can never
    // silently regress to a co-tenant variant.
    //
    // GIVEN a recording dir pre-staged with a usage log and the CA the
    // sidecar entrypoint would drop at boot
    const runner = new FakeRunner();
    const dir = `.runs/test-recording-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "egress-usage.ndjson"),
      '{"provider":"anthropic","model":"claude-haiku-4-5","input_tokens":10,"output_tokens":5}\n',
    );
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN applying the jail as the namespace owner, publishing the
    // gateway port on behalf of the tenants that will join it
    const jail = await applyDockerEgressJail(runner, {
      runId: "eval-run-3",
      allowHosts: ["api.anthropic.com"],
      recordingDir: dir,
      recordingImage: "recording:local",
      recordingDockerfileDir: "/workspace/evals/recording",
      publishPorts: [{ hostPort: 41234, containerPort: 7830 }],
    });

    // THEN the jail pre-cleans its container and network, builds the
    // image, creates the network it owns, then starts attached to that
    // network (NOT another container's netns).
    expect(runner.runs[0]).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-3-egress-jail"],
    });
    expect(runner.runs[1]).toEqual({
      command: "docker",
      args: ["network", "rm", "eval-run-3-egress-net"],
    });
    expect(runner.runs[2]).toEqual({
      command: "docker",
      args: ["build", "-t", "recording:local", "/workspace/evals/recording"],
    });
    expect(runner.runs[3]).toEqual({
      command: "docker",
      args: ["network", "create", "eval-run-3-egress-net"],
    });

    const dockerRun = runner.runs[4];
    expect(dockerRun?.args).toContain("-d");
    expect(dockerRun?.args).toContain("evals.vellum.ai/egress-recording=1");
    expect(dockerRun?.args).toContain("ALLOW_HOSTS=api.anthropic.com");
    // AND it owns the network rather than borrowing a container's netns.
    const networkIdx = dockerRun?.args.indexOf("--network") ?? -1;
    expect(networkIdx).toBeGreaterThanOrEqual(0);
    expect(dockerRun?.args[networkIdx + 1]).toBe("eval-run-3-egress-net");
    // AND it publishes the gateway port the tenant can't publish itself.
    expect(dockerRun?.args).toContain("-p");
    expect(dockerRun?.args).toContain("41234:7830");
    const resolvedDir = resolve(dir);
    const mountArg = dockerRun?.args.find((arg) =>
      arg?.includes(":/recording"),
    );
    expect(mountArg).toBe(`${resolvedDir}:/recording`);

    // AND it surfaces the netns container + CA path so the caller can
    // hand them to `hatch --netns-container` / `--assistant-ca-cert`.
    expect(jail.netnsContainer).toBe("eval-run-3-egress-jail");
    expect(jail.caCertPath).toBe(resolve(dir, "mitmproxy-ca-cert.pem"));

    // AND owner mode never installs the CA itself — tenants trust it at
    // launch via hatch, so there must be no `docker cp` / `update-ca`.
    expect(runner.runs.some((r) => r.args[0] === "cp")).toBe(false);
    expect(
      runner.runs.some((r) => r.args.includes("update-ca-certificates")),
    ).toBe(false);

    await expect(jail.readUsageRecords()).resolves.toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        input_tokens: 10,
        output_tokens: 5,
      },
    ]);

    // AND teardown removes the jail container then the network it owns.
    await jail.stop();
    expect(runner.runs.at(-2)).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-3-egress-jail"],
    });
    expect(runner.runs.at(-1)).toEqual({
      command: "docker",
      args: ["network", "rm", "eval-run-3-egress-net"],
    });
  });

  test("owner mode omits publish args when no ports are requested", async () => {
    // GIVEN a recording dir but no ports to publish (e.g. a tenant
    // reached purely via `docker exec`)
    const runner = new FakeRunner();
    const dir = `.runs/test-no-ports-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN applying the jail without publishPorts
    await applyDockerEgressJail(runner, {
      runId: "eval-no-ports",
      recordingDir: dir,
    });

    // THEN the `docker run` carries no `-p` mapping.
    expect(runner.runs[4]?.args).not.toContain("-p");
  });

  test("owner mode defaults to the combined model+infra allowlist", async () => {
    // GIVEN a recording dir
    const runner = new FakeRunner();
    const dir = `.runs/test-allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN applying the jail without an explicit allowHosts
    await applyDockerEgressJail(runner, {
      runId: "eval-run-2",
      recordingDir: dir,
    });

    // THEN it wires up the full default allowlist. runs[4] is the
    // `docker run -d` (rm / network rm / build / network create precede).
    expect(DEFAULT_MODEL_ALLOW_HOSTS).toContain("api.anthropic.com");
    expect(runner.runs[4]?.args).toContain(
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
    // The mitmproxy addon (addon.py) only parses usage for the
    // providers it recognizes (Anthropic today); other model hosts
    // flow through unparsed. Adding a non-model host here would be dead
    // code in the addon at best, so new infra hosts belong in
    // DEFAULT_INFRA_ALLOW_HOSTS. Fireworks is a genuine model provider
    // (open-weight models over an OpenAI-compatible API), so it belongs
    // here even though its usage isn't parsed yet.
    expect(DEFAULT_MODEL_ALLOW_HOSTS.sort()).toEqual([
      "api.anthropic.com",
      "api.fireworks.ai",
      "api.openai.com",
      "generativelanguage.googleapis.com",
    ]);
  });

  test("an explicit allowHosts override still wins over the default", async () => {
    // GIVEN a recording dir
    const runner = new FakeRunner();
    const dir = `.runs/test-allowlist-override-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN applying the jail with an explicit allowHosts
    await applyDockerEgressJail(runner, {
      runId: "eval-run-3",
      recordingDir: dir,
      allowHosts: ["example.test"],
    });

    // THEN the override wins over the default allowlist.
    expect(runner.runs[4]?.args).toContain("ALLOW_HOSTS=example.test");
  });

  test("owner mode mounts plugin fixtures dir + sets PLUGIN_FIXTURES_DIR env when configured", async () => {
    // GIVEN a recording dir and a fixtures source dir
    const runner = new FakeRunner();
    const dir = `.runs/test-fixtures-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    const fixturesDir = `.runs/test-fixtures-src-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(fixturesDir, { recursive: true });

    // WHEN applying the jail with pluginFixturesDir set
    await applyDockerEgressJail(runner, {
      runId: "eval-run-fixtures",
      recordingDir: dir,
      pluginFixturesDir: fixturesDir,
    });

    // THEN the `docker run` bind-mounts the fixtures and points the
    // addon at them.
    const dockerRun = runner.runs[4];
    expect(dockerRun?.command).toBe("docker");
    const fixturesMount = dockerRun?.args.find((arg) =>
      arg?.includes(":/fixtures:ro"),
    );
    expect(fixturesMount).toBe(`${resolve(fixturesDir)}:/fixtures:ro`);
    expect(dockerRun?.args).toContain("PLUGIN_FIXTURES_DIR=/fixtures");
  });

  test("owner mode omits plugin fixtures args when pluginFixturesDir is not provided", async () => {
    // GIVEN a recording dir without fixtures
    const runner = new FakeRunner();
    const dir = `.runs/test-no-fixtures-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN applying the jail without pluginFixturesDir
    await applyDockerEgressJail(runner, {
      runId: "eval-run-no-fixtures",
      recordingDir: dir,
    });

    // THEN no fixtures mount or env is wired up.
    const dockerRun = runner.runs[4];
    const fixturesMount = dockerRun?.args.find((arg) =>
      arg?.includes(":/fixtures"),
    );
    expect(fixturesMount).toBeUndefined();
    expect(dockerRun?.args).not.toContain("PLUGIN_FIXTURES_DIR=/fixtures");
  });

  test("installRecordingCa patches the jail's CA into a tenant's trust store", async () => {
    // A tenant born into the owner-mode jail (e.g. Hermes via `--network
    // container:<jail>`) doesn't get the CA from process start, so it must
    // be copied in and trusted before the tenant's first model TLS.
    //
    // GIVEN a recording dir pre-staged with the sidecar CA
    const runner = new FakeRunner();
    const dir = `.runs/test-ca-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");

    // WHEN installing the recording CA into a tenant container
    await installRecordingCa(runner, dir, "eval-run-ca-hermes");

    // THEN it copies the CA in then refreshes the trust store — the cp must
    // precede update-ca-certificates or the exec sees a stale store.
    expect(runner.runs[0]?.args).toEqual([
      "cp",
      resolve(dir, "mitmproxy-ca-cert.pem"),
      "eval-run-ca-hermes:/usr/local/share/ca-certificates/vellum-evals-mitmproxy.crt",
    ]);
    expect(runner.runs[1]?.args).toEqual([
      "exec",
      "eval-run-ca-hermes",
      "update-ca-certificates",
    ]);
  });
});

import { describe, expect, test } from "bun:test";

import {
  dockerEgressProxyName,
  egressProxyEnv,
  prepareDockerEgressJail,
  vellumDockerResourceNames,
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
  test("derives Docker names from the Vellum instance name", () => {
    expect(vellumDockerResourceNames("eval-vellum-bare")).toEqual({
      assistantContainer: "eval-vellum-bare-assistant",
      networkName: "eval-vellum-bare-net",
    });
    expect(dockerEgressProxyName("eval-vellum-bare")).toBe(
      "eval-vellum-bare-egress-proxy",
    );
  });

  test("returns proxy env forwarded into hatch", () => {
    expect(egressProxyEnv("proxy", 8080)).toMatchObject({
      VELLUM_ASSISTANT_HTTP_PROXY: "http://proxy:8080",
      VELLUM_ASSISTANT_HTTPS_PROXY: "http://proxy:8080",
      VELLUM_DOCKER_NETWORK_PRECREATED: "1",
      VELLUM_ASSISTANT_NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  test("creates an internal network and dual-homes the proxy", async () => {
    const runner = new FakeRunner();
    const jail = await prepareDockerEgressJail(runner, {
      instanceName: "eval-run",
      networkName: "eval-run-net",
      allowHosts: ["api.anthropic.com"],
    });

    expect(jail.proxyContainer).toBe("eval-run-egress-proxy");
    expect(runner.runs.map((r) => [r.command, ...r.args])).toEqual([
      ["docker", "rm", "-f", "eval-run-egress-proxy"],
      ["docker", "network", "rm", "eval-run-net"],
      ["docker", "network", "create", "--internal", "eval-run-net"],
      expect.arrayContaining([
        "docker",
        "run",
        "-d",
        "--name",
        "eval-run-egress-proxy",
        "-e",
        "ALLOW_HOSTS=api.anthropic.com",
      ]),
      [
        "docker",
        "network",
        "connect",
        "--alias",
        "eval-run-egress-proxy",
        "eval-run-net",
        "eval-run-egress-proxy",
      ],
    ]);
  });
});

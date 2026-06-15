import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import { VellumAgent, normalizeVellumEventStream } from "../adapters/vellum";
import { runArtifacts } from "../metrics";
import type { Profile } from "../profile";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
  SpawnedProcess,
} from "../runtime/command-runner";

// Adapter computes the repo root the same way: four `..`s up from its own
// file. `__tests__/` sits at the same depth as `adapters/` so the same
// expression yields the same path here.
const ADAPTER_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

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

interface RunCall {
  command: string;
  args: string[];
  opts?: RunOptions;
}

class FakeRunner implements CommandRunner {
  readonly runs: RunCall[] = [];
  readonly spawns: Array<{ command: string; args: string[] }> = [];
  readonly process = new FakeProcess();

  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    this.runs.push({ command, args, opts });
    // Two call shapes invoke `assistant conversations new` in the
    // adapter:
    //   1. `seed-conversation` builds a single shell script and
    //      passes it as the last arg of `vellum exec -- sh -lc <script>`.
    //   2. `newConversation()` passes the assistant CLI verb tokens
    //      directly: `vellum exec <id> -- assistant conversations new`.
    // Matching on the joined args string covers both without having
    // to teach the runner each shape.
    const joined = args.join(" ");
    const stdout = joined.includes("assistant conversations new")
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
  id: "vellum-default",
  manifest: {
    species: "vellum",
    setup: ["assistant plugins install simple-memory"],
  },
  workspaceDir: "/profiles/vellum-default/workspace",
};

async function preStageRecordingCa(runId: string): Promise<void> {
  // applyDockerEgressJail's installRecordingCa polls for this file
  // for 10s before timing out. In production the recording sidecar's
  // entrypoint drops it at boot; tests skip that path, so we pre-stage
  // a fake CA in the host-side recordingDir directly.
  const runDir = runArtifacts(runId).runDir;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");
}

describe("VellumAgent", () => {
  test("creates the egress jail as netns owner, hatches the assistant into it, runs setup, and subscribes to events", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      cliCommand: "vellum",
      profile,
      testId: "timeline-recall",
      runId: "eval-run-1",
      // Pin to empty so a host-shell `ANTHROPIC_API_KEY` (or any other
      // provider var) doesn't leak into the `env: {}` assertion below.
      // The provider-forwarding contract has its own dedicated tests.
      processEnv: {},
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    expect(agent.id).toBe("eval-run-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-run-1");
    // The jail is created FIRST as the netns owner, then hatch joins
    // the assistant into it. runs[0..4] are the jail's lifecycle:
    // pre-clean container, pre-clean network, build image, create the
    // network it owns, start attached to that network.
    expect(runner.runs[0]).toEqual({
      command: "docker",
      args: ["rm", "-f", "eval-run-1-egress-jail"],
    });
    expect(runner.runs[1]).toEqual({
      command: "docker",
      args: ["network", "rm", "eval-run-1-egress-net"],
    });
    expect(runner.runs[2].command).toBe("docker");
    expect(runner.runs[2].args[0]).toBe("build");
    expect(runner.runs[2].args[1]).toBe("-t");
    expect(runner.runs[2].args[2]).toBe("vellum-evals-recording-jail:local");
    expect(runner.runs[3]).toEqual({
      command: "docker",
      args: ["network", "create", "eval-run-1-egress-net"],
    });
    // The jail owns the network (NOT another container's netns) and
    // publishes the gateway port the tenants can't publish themselves.
    expect(runner.runs[4].command).toBe("docker");
    expect(runner.runs[4].args.slice(0, 6)).toEqual([
      "run",
      "-d",
      "--name",
      "eval-run-1-egress-jail",
      "--network",
      "eval-run-1-egress-net",
    ]);
    expect(runner.runs[4].args).toContain("--cap-add");
    expect(runner.runs[4].args).toContain("NET_ADMIN");
    expect(runner.runs[4].args).toContain("evals.vellum.ai/egress-recording=1");
    expect(runner.runs[4].args).toContain("-p");

    // hatch comes AFTER the jail and joins the assistant/gateway/CES
    // into the jail's namespace, trusting its CA from process start.
    const hatchCall = runner.runs[5];
    expect(hatchCall.command).toBe("vellum");
    expect(hatchCall.args.slice(0, 8)).toEqual([
      "hatch",
      "vellum",
      "--remote",
      "docker",
      "--source",
      ADAPTER_REPO_ROOT,
      "--name",
      "eval-run-1",
    ]);
    const netnsIdx = hatchCall.args.indexOf("--netns-container");
    expect(hatchCall.args[netnsIdx + 1]).toBe("eval-run-1-egress-jail");
    const gatewayPortIdx = hatchCall.args.indexOf("--gateway-port");
    expect(Number(hatchCall.args[gatewayPortIdx + 1])).toBeGreaterThan(0);
    const caIdx = hatchCall.args.indexOf("--assistant-ca-cert");
    expect(hatchCall.args[caIdx + 1]).toMatch(/mitmproxy-ca-cert\.pem$/);
    // logPath routes hatch's stdout/stderr into the per-run
    // subprocess-hatch.log file so the report UI can render it even
    // when the run failed before assistant_complete fired. logStep
    // tags every line in that file with `[hatch]` so the inline UI
    // renderer can pick out which subprocess each line belongs to.
    expect(hatchCall.opts).toEqual({
      env: {},
      logPath: expect.stringMatching(/\/subprocess-hatch\.log$/),
      logStep: "hatch",
    });
    // Species default feature flag — runs after hatch and before the
    // first setup command. See VELLUM_DEFAULT_FEATURE_FLAGS in the
    // adapter for the canonical list.
    expect(runner.runs[6]).toEqual({
      command: "vellum",
      args: [
        "flags",
        "set",
        "external-plugins",
        "true",
        "--assistant",
        "eval-run-1",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-feature-flag-1\.log$/),
        logStep: "feature-flag-1",
      },
    });
    // Setup command — gets a per-step subprocess-setup-N.log
    expect(runner.runs[7]).toEqual({
      command: "vellum",
      args: [
        "exec",
        "eval-run-1",
        "--",
        "sh",
        "-lc",
        "assistant plugins install simple-memory",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-setup-1\.log$/),
        logStep: "setup-1",
      },
    });
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

  test("applies vellum species default flags via `vellum flags set --assistant <id>` BEFORE setup commands", async () => {
    const runner = new FakeRunner();
    // Ordering invariants under test:
    //   (a) species default flags come AFTER hatch (runs[5]) but
    //       BEFORE any setup command — gated setup steps (e.g.
    //       `assistant plugins install`) depend on the flag being
    //       flipped first.
    //   (b) `--assistant <this.id>` is passed explicitly so the
    //       user's active-assistant pointer is never mutated by an
    //       eval run.
    const profileWithSetup: Profile = {
      id: "vellum-simple-memory",
      manifest: {
        species: "vellum",
        setup: ["assistant plugins install simple-memory"],
      },
      workspaceDir: "/profiles/vellum-simple-memory/workspace",
    };
    const agent = new VellumAgent({
      runner,
      cliCommand: "vellum",
      profile: profileWithSetup,
      testId: "timeline-recall",
      runId: "eval-run-2",
      processEnv: {},
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // runs[0..4] are the jail lifecycle (rm / network rm / build /
    // network create / run); runs[5] is hatch joining the assistant
    // into the jail's namespace. Confirm the count to anchor the
    // indices: 6 pre-flag steps + 1 species default flag
    // (`external-plugins`) + 1 setup command = 8.
    expect(runner.runs.length).toBe(8);
    expect(runner.runs[5].args[0]).toBe("hatch");

    // Species default: `external-plugins` is always flipped ON for
    // vellum hatches, regardless of manifest contents.
    expect(runner.runs[6]).toEqual({
      command: "vellum",
      args: [
        "flags",
        "set",
        "external-plugins",
        "true",
        "--assistant",
        "eval-run-2",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-feature-flag-1\.log$/),
        logStep: "feature-flag-1",
      },
    });

    // Setup command lands AFTER the species default flag — this is the
    // chicken-and-egg property the ordering protects.
    expect(runner.runs[7]).toEqual({
      command: "vellum",
      args: [
        "exec",
        "eval-run-2",
        "--",
        "sh",
        "-lc",
        "assistant plugins install simple-memory",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-setup-1\.log$/),
        logStep: "setup-1",
      },
    });
  });

  test("species default flags still apply to a profile with no setup commands (the bare vellum case)", async () => {
    const runner = new FakeRunner();
    // The "no setup commands" case is structurally distinct from "no
    // flags" — `vellum-default` exists precisely to exercise the bare
    // species path. Even with zero setup commands, the species default
    // flag must land so a downstream test that calls `assistant
    // plugins install` from inside the agent doesn't trip the gate.
    const bareProfile: Profile = {
      id: "vellum-default",
      manifest: { species: "vellum" },
      workspaceDir: "/profiles/vellum-default/workspace",
    };
    const agent = new VellumAgent({
      runner,
      cliCommand: "vellum",
      profile: bareProfile,
      testId: "timeline-recall",
      runId: "eval-run-3",
      processEnv: {},
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // jail lifecycle (rm / network rm / build / network create / run) +
    // hatch + 1 species default flag = 7. No setup commands.
    expect(runner.runs.length).toBe(7);
    expect(runner.runs[6]).toEqual({
      command: "vellum",
      args: [
        "flags",
        "set",
        "external-plugins",
        "true",
        "--assistant",
        "eval-run-3",
      ],
      opts: {
        logPath: expect.stringMatching(/\/subprocess-feature-flag-1\.log$/),
        logStep: "feature-flag-1",
      },
    });
  });

  test("forwards LLM provider API keys from process env into the hatch subprocess", async () => {
    const runner = new FakeRunner();
    // Mix recognized provider vars (should be forwarded), an empty provider
    // var (should be dropped, not propagated as ""), and an unrelated var
    // (should be ignored — the adapter only forwards the explicit allowlist).
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-env",
      processEnv: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-openai-test",
        FIREWORKS_API_KEY: "",
        SHELL: "/bin/zsh",
      },
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const hatchCall = runner.runs.find((r) => r.args[0] === "hatch");
    expect(hatchCall).toBeDefined();
    expect(hatchCall?.opts?.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
    });
  });

  test("forwards an empty env to hatch when no provider keys are set", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-noenv",
      processEnv: { PATH: "/usr/bin" },
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const hatchCall = runner.runs.find((r) => r.args[0] === "hatch");
    expect(hatchCall?.opts?.env).toEqual({});
  });

  test("seeds deterministic conversation history through the adapter bridge", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-seed",
    });

    await preStageRecordingCa(agent.id);
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
      "eval-run-seed-assistant:/tmp/eval-run-seed-conversation-seed.json",
    );

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
    expect(seedRun.args[5]).toContain("assistant conversations new");
    expect(seedRun.args[5]).not.toContain("--conversation-key");
    expect(seedRun.args[5]).toContain(
      "--content-file '/tmp/eval-run-seed-conversation-seed.json'",
    );
    expect(seedRun.args[5]).toContain(
      "rm -f '/tmp/eval-run-seed-conversation-seed.json'",
    );
    expect(seedRun.args[5]).not.toContain("remember this exact note");
    expect(seedRun.args[5]).not.toContain("noted");
    expect(agent.conversationKey).toBe("generated-key-123");
  });

  test("stage-workspace-file setup command docker cp's the payload into the workspace", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "restaurant-pnl-spend",
      runId: "eval-run-stage",
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const baseline = runner.runs.length;
    await agent.runSetupCommand({
      type: "stage-workspace-file",
      path: "restaurant-pnl.csv",
      content: "Category,Amount (USD)\nLabor,48200\n",
    });
    const newRuns = runner.runs.slice(baseline);

    // mkdir -p the (root) parent, then docker cp the file into /workspace.
    expect(newRuns[0].args.slice(0, 2)).toEqual([
      "exec",
      "eval-run-stage-assistant",
    ]);
    expect(newRuns[0].args.slice(2)).toEqual(["mkdir", "-p", "/workspace"]);
    expect(newRuns[1].command).toBe("docker");
    expect(newRuns[1].args[0]).toBe("cp");
    expect(newRuns[1].args[2]).toBe(
      "eval-run-stage-assistant:/workspace/restaurant-pnl.csv",
    );
  });

  test("sends through the same conversation key and shuts down resources", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-run-2",
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();
    agent.events();
    await agent.send({ content: "hello" });
    await agent.shutdown();

    // The shutdown sequence tail, in order. The jail owns the network
    // namespace its tenants join, so the tenants (assistant/gateway/CES)
    // must be retired and reaped BEFORE `jail.stop()` removes the jail
    // container and the network it owns — Docker refuses to remove a
    // container whose netns another container still shares.
    //  1. `vellum message ...` (final user turn)
    //  2. `vellum retire <runId>` (retire the tenants)
    //  3–5. `docker rm -f <runId>-<sibling>` ×3 (force-reap fallback,
    //       iterating assistant → gateway → credential-executor in
    //       `VELLUM_HATCH_SERVICES` order)
    //  6. `docker rm -f <runId>-egress-jail` (jail.stop(), owner last)
    //  7. `docker network rm <runId>-egress-net` (jail's owned network)
    expect(runner.runs.map((r) => [r.command, ...r.args]).slice(-7)).toEqual([
      [
        "vellum",
        "message",
        "eval-run-2",
        "--conversation-key",
        "evals:timeline-recall:eval-run-2",
        "hello",
      ],
      ["vellum", "retire", "eval-run-2"],
      ["docker", "rm", "-f", "eval-run-2-assistant"],
      ["docker", "rm", "-f", "eval-run-2-gateway"],
      ["docker", "rm", "-f", "eval-run-2-credential-executor"],
      ["docker", "rm", "-f", "eval-run-2-egress-jail"],
      ["docker", "network", "rm", "eval-run-2-egress-net"],
    ]);
    expect(runner.process.killed).toBe(true);
  });

  test("captures forensics for every sibling container but does NOT retire when hatch itself failed", async () => {
    // Catch-path teardown policy (see vellum.ts for the full rationale):
    //
    // - `captureContainerForensics` is read-only (`docker inspect` /
    //   `docker logs --tail 200`), so it ALWAYS runs on failure —
    //   including port-collision failures that never created our
    //   containers. This is the value the report-UI's `dockerArtifacts`
    //   section relies on.
    // - `vellum retire` is destructive (`docker rm -f` + network +
    //   volume teardown), so it ONLY runs when hatch returned 0 and
    //   we know the resources under `instanceName` are ours. When
    //   hatch itself fails, we deliberately leak our own dead
    //   resources rather than risk tearing down a parallel run's
    //   live containers in the (very rare with `findOpenPort()` +
    //   ms+random `runId`) "name already exists" edge case.
    class FailingRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        if (args[0] === "hatch") {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "docker: Error response from daemon: Conflict. The container name is already in use",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const runner = new FailingRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-vellum-default-x-20260524160000123-abcd",
    });

    // The jail is created before hatch, so its CA poll must resolve;
    // pre-stage the CA the recording sidecar would drop at boot.
    await preStageRecordingCa(agent.id);
    await expect(agent.hatch()).rejects.toThrow(/name is already in use/);
    const sequence = runner.runs.map((r) => [r.command, ...r.args]);

    // Hatch attempted exactly once.
    const hatchCalls = sequence.filter(
      (parts) => parts[0] === "vellum" && parts[1] === "hatch",
    );
    expect(hatchCalls).toHaveLength(1);

    // Forensics captured for ALL three sibling containers — the
    // gateway inspect is the actionable artifact for port-collision
    // failures, the assistant inspect carries OOM/build-failure
    // signals, the credential-executor inspect covers volume mount
    // failures.
    const inspectCalls = sequence.filter(
      (parts) => parts[0] === "docker" && parts[1] === "inspect",
    );
    expect(inspectCalls.map((c) => c[2])).toEqual([
      "eval-vellum-default-x-20260524160000123-abcd-assistant",
      "eval-vellum-default-x-20260524160000123-abcd-gateway",
      "eval-vellum-default-x-20260524160000123-abcd-credential-executor",
    ]);
    const logCalls = sequence.filter(
      (parts) =>
        parts[0] === "docker" &&
        parts[1] === "logs" &&
        parts[2] === "--tail" &&
        parts[3] === "200",
    );
    expect(logCalls.map((c) => c[4])).toEqual([
      "eval-vellum-default-x-20260524160000123-abcd-assistant",
      "eval-vellum-default-x-20260524160000123-abcd-gateway",
      "eval-vellum-default-x-20260524160000123-abcd-credential-executor",
    ]);

    // CRITICAL: retire must NOT have been called. The hatch subprocess
    // exited non-zero (the resources under our instanceName may belong
    // to a parallel run holding the name), so the catch path skips
    // teardown — we'd rather leak our own dead resources than wipe a
    // healthy parallel run.
    const retireCalls = sequence.filter(
      (parts) => parts[0] === "vellum" && parts[1] === "retire",
    );
    expect(retireCalls).toHaveLength(0);
  });

  test("retires the run when hatch succeeds but a later step (setup command) fails", async () => {
    // The other half of the catch-path policy: once `vellum hatch`
    // returned 0, the resources under our instanceName are
    // unambiguously ours, so any subsequent throw (setup command,
    // jail application) MUST retire them — otherwise the operator
    // accumulates leaked instances across every failed eval run.
    class HatchOkSetupFails extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        // Setup commands are dispatched as `vellum exec <id> -- …`.
        // Guard on `command === "vellum"` so `docker exec
        // update-ca-certificates` (CA handoff) is not accidentally
        // intercepted and returned as a failure.
        if (command === "vellum" && args[0] === "exec") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "setup command crashed",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    // Use a profile variant that actually has a setup command so the
    // failing branch is reached.
    const profileWithSetup = {
      ...profile,
      manifest: {
        ...profile.manifest,
        setup: ["echo hello"],
      },
    };

    const runner = new HatchOkSetupFails();
    const agent = new VellumAgent({
      runner,
      profile: profileWithSetup,
      testId: "timeline-recall",
      runId: "eval-vellum-default-x-20260524160000123-abcd",
    });

    await preStageRecordingCa(agent.id);
    await expect(agent.hatch()).rejects.toThrow(/setup command/i);
    const sequence = runner.runs.map((r) => [r.command, ...r.args]);

    const retireCalls = sequence.filter(
      (parts) => parts[0] === "vellum" && parts[1] === "retire",
    );
    expect(retireCalls).toHaveLength(1);
    expect(retireCalls[0][2]).toBe(
      "eval-vellum-default-x-20260524160000123-abcd",
    );
  });

  test("force-reaps every sibling container after retire (defense-in-depth against silent retire failures)", async () => {
    // A `vellum retire` that returns non-zero leaves the tenant
    // containers alive. Because they share the egress jail's network
    // namespace, the leak also blocks `jail.stop()` from removing the
    // jail container and its network. The fallback reap calls `docker
    // rm -f` per sibling regardless of retire's exit code — if retire's
    // own rm succeeded we're a no-op; if it failed we close the leak so
    // the subsequent jail teardown can proceed.
    class HatchOkSetupFails extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        // Guard on `command === "vellum"` so `docker exec
        // update-ca-certificates` is not intercepted here.
        if (command === "vellum" && args[0] === "exec") {
          return { exitCode: 1, stdout: "", stderr: "setup command crashed" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const profileWithSetup = {
      ...profile,
      manifest: { ...profile.manifest, setup: ["echo hello"] },
    };
    const runner = new HatchOkSetupFails();
    const runId = "eval-vellum-default-reap-20260524160000123-abcd";
    const agent = new VellumAgent({
      runner,
      profile: profileWithSetup,
      testId: "timeline-recall",
      runId,
    });

    await preStageRecordingCa(agent.id);
    await expect(agent.hatch()).rejects.toThrow(/setup command/i);

    // The reaper calls `docker rm -f <name>` for each of the three
    // sibling Vellum hatch containers. Use exact equality (not
    // startsWith) so unrelated `docker rm -f <runId>-egress-jail`
    // calls from the jail's pre-clean step don't poison the assertion.
    const siblingNames = new Set([
      `${runId}-assistant`,
      `${runId}-credential-executor`,
      `${runId}-gateway`,
    ]);
    const dockerRmCalls = runner.runs
      .filter(
        (r) =>
          r.command === "docker" &&
          r.args[0] === "rm" &&
          r.args[1] === "-f" &&
          typeof r.args[2] === "string" &&
          siblingNames.has(r.args[2]),
      )
      .map((r) => r.args[2]);
    expect(dockerRmCalls.sort()).toEqual([...siblingNames].sort());
  });

  test("surfaces a [retire] warning when `vellum retire` exits non-zero", async () => {
    // A swallowed retire failure gives operators no trail back to the
    // root cause — the leaked tenant containers and the blocked jail
    // teardown look like spontaneous failures. The structured warn
    // lands the root cause in the runner's subprocess log alongside the
    // original error.
    class HatchOkSetupFailsRetireFails extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        // Guard on `command === "vellum"` so `docker exec
        // update-ca-certificates` is not intercepted here.
        if (command === "vellum" && args[0] === "exec") {
          return { exitCode: 1, stdout: "", stderr: "setup command crashed" };
        }
        if (args[0] === "retire") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Could not find assistant entry",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }

    const profileWithSetup = {
      ...profile,
      manifest: { ...profile.manifest, setup: ["echo hello"] },
    };
    const runner = new HatchOkSetupFailsRetireFails();
    const runId = "eval-vellum-default-retire-warn-20260524160000123-abcd";
    const agent = new VellumAgent({
      runner,
      profile: profileWithSetup,
      testId: "timeline-recall",
      runId,
    });

    await preStageRecordingCa(agent.id);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      if (typeof msg === "string") warnings.push(msg);
    };
    try {
      await expect(agent.hatch()).rejects.toThrow(/setup command/i);
    } finally {
      console.warn = originalWarn;
    }

    const retireWarning = warnings.find((w) =>
      w.startsWith("[retire] vellum retire"),
    );
    expect(retireWarning).toBeDefined();
    expect(retireWarning).toContain(runId);
    expect(retireWarning).toContain("Could not find assistant entry");
  });

  // The two capability methods below back the LongMemEval-V2
  // two-conversation runner (`runIngestAsk`). They both go through
  // the assistant container — `writeWorkspaceFile` via `docker cp`
  // into the `/workspace` mount, `newConversation` via `vellum exec
  // assistant conversations new` — so the FakeRunner trace asserts
  // we shape those calls correctly without standing up Docker.

  test("writeWorkspaceFile docker-mkdir's the parent and docker cp's the payload into the container workspace", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-write-1",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const baseline = runner.runs.length;
    await agent.writeWorkspaceFile!({
      path: "inputs/longmemeval/q_001/haystack.jsonl",
      content: '{"id":"t1"}\n',
    });
    const newRuns = runner.runs.slice(baseline);

    // First new call: docker exec <container> mkdir -p <parent>
    expect(newRuns[0].command).toBe("docker");
    expect(newRuns[0].args.slice(0, 2)).toEqual([
      "exec",
      "eval-write-1-assistant",
    ]);
    expect(newRuns[0].args.slice(2)).toEqual([
      "mkdir",
      "-p",
      "/workspace/inputs/longmemeval/q_001",
    ]);

    // Second new call: docker cp <stage> <container>:/workspace/<path>
    expect(newRuns[1].command).toBe("docker");
    expect(newRuns[1].args[0]).toBe("cp");
    expect(newRuns[1].args[2]).toBe(
      "eval-write-1-assistant:/workspace/inputs/longmemeval/q_001/haystack.jsonl",
    );
  });

  test("writeWorkspaceFile rejects absolute paths", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-write-abs",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    await expect(
      agent.writeWorkspaceFile!({ path: "/etc/passwd", content: "x" }),
    ).rejects.toThrow(/absolute path/);
  });

  test("writeWorkspaceFile rejects parent-traversal segments", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-write-traverse",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    await expect(
      agent.writeWorkspaceFile!({
        path: "inputs/../../etc/passwd",
        content: "x",
      }),
    ).rejects.toThrow(/escape the workspace root/);
  });

  test("writeWorkspaceFile rejects an empty path", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-write-empty",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    await expect(
      agent.writeWorkspaceFile!({ path: "", content: "x" }),
    ).rejects.toThrow(/non-empty/);
  });

  test("writeWorkspaceFile throws when the agent has not been hatched", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-write-prehatch",
    });

    await expect(
      agent.writeWorkspaceFile!({ path: "a.txt", content: "x" }),
    ).rejects.toThrow(/has not been hatched/);
  });

  // `resolveAppPage` reads the newest compiled sandbox app out of the
  // assistant container (`/workspace/data/apps/<dir>/dist/`) and inlines
  // it into one self-contained page for the browser-interaction phase.
  // The runner-facing contract is the `docker exec` shape (an `ls` probe
  // then a `cat` per dist file) plus the inlined result, so the
  // FakeRunner trace asserts both without standing up Docker.

  const APP_INDEX_HTML = [
    "<!doctype html>",
    '<html><head><link rel="stylesheet" href="main.css"></head>',
    '<body><script type="module" src="main.js"></script></body></html>',
  ].join("\n");

  // Records the `docker exec` app-resolution calls and answers the `ls`
  // probe + per-file `cat`s from configurable state, delegating the
  // jail/hatch lifecycle to the base FakeRunner. A `cat` for a path
  // absent from `files` exits non-zero, mimicking a missing dist asset.
  class AppPageRunner extends FakeRunner {
    newestIndexPath = "/workspace/data/apps/calc/dist/index.html";
    files: Record<string, string> = {
      "/workspace/data/apps/calc/dist/index.html": APP_INDEX_HTML,
      "/workspace/data/apps/calc/dist/main.js": 'console.log("calc");',
      "/workspace/data/apps/calc/dist/main.css": "body { color: blue; }",
    };

    override async run(
      command: string,
      args: string[],
      opts?: RunOptions,
    ): Promise<CommandResult> {
      if (command === "docker" && args[0] === "exec") {
        this.runs.push({ command, args, opts });
        if (args[2] === "sh") {
          return {
            exitCode: 0,
            stdout: `${this.newestIndexPath}\n`,
            stderr: "",
          };
        }
        if (args[2] === "cat") {
          const content = this.files[args[3]];
          if (content === undefined) {
            return { exitCode: 1, stdout: "", stderr: "cat: no such file" };
          }
          return { exitCode: 0, stdout: content, stderr: "" };
        }
      }
      return super.run(command, args, opts);
    }
  }

  test("resolveAppPage probes for the newest app and inlines its dist into one page", async () => {
    // GIVEN a hatched agent whose container holds a compiled app with
    // both optional dist assets present
    const runner = new AppPageRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "calculator-app",
      runId: "eval-apppage-1",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const baseline = runner.runs.length;

    // WHEN the runner resolves the app page
    const page = await agent.resolveAppPage!();

    // THEN it first runs an `ls -1t` probe for the newest dist/index.html,
    // then cats index.html and both optional assets out of the container.
    const newRuns = runner.runs.slice(baseline);
    expect(newRuns[0].command).toBe("docker");
    expect(newRuns[0].args.slice(0, 4)).toEqual([
      "exec",
      "eval-apppage-1-assistant",
      "sh",
      "-lc",
    ]);
    expect(newRuns[0].args[4]).toContain(
      "ls -1t /workspace/data/apps/*/dist/index.html",
    );
    expect(newRuns[1].args).toEqual([
      "exec",
      "eval-apppage-1-assistant",
      "cat",
      "/workspace/data/apps/calc/dist/index.html",
    ]);
    expect(newRuns[2].args[3]).toBe("/workspace/data/apps/calc/dist/main.js");
    expect(newRuns[3].args[3]).toBe("/workspace/data/apps/calc/dist/main.css");

    // AND the returned page inlines both assets into the index document.
    expect(page?.html).toContain(
      '<script type="module">console.log("calc");</script>',
    );
    expect(page?.html).toContain("<style>body { color: blue; }</style>");
  });

  test("resolveAppPage returns undefined when no app was built", async () => {
    // GIVEN a hatched agent whose container holds no compiled app
    const runner = new AppPageRunner();
    runner.newestIndexPath = "";
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "calculator-app",
      runId: "eval-apppage-empty",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const baseline = runner.runs.length;

    // WHEN the runner resolves the app page
    const page = await agent.resolveAppPage!();

    // THEN the empty `ls` probe short-circuits to undefined with no `cat`.
    expect(page).toBeUndefined();
    const newRuns = runner.runs.slice(baseline);
    expect(newRuns).toHaveLength(1);
    expect(newRuns[0].args[2]).toBe("sh");
  });

  test("resolveAppPage omits a dist asset that is absent from the container", async () => {
    // GIVEN a hatched agent whose app has no main.css on disk
    const runner = new AppPageRunner();
    delete runner.files["/workspace/data/apps/calc/dist/main.css"];
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "calculator-app",
      runId: "eval-apppage-nocss",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // WHEN the runner resolves the app page
    const page = await agent.resolveAppPage!();

    // THEN the missing stylesheet's reference is left untouched while the
    // present script is still inlined.
    expect(page?.html).toContain(
      '<script type="module">console.log("calc");</script>',
    );
    expect(page?.html).toContain('<link rel="stylesheet" href="main.css">');
  });

  test("resolveAppPage throws when the agent has not been hatched", async () => {
    // GIVEN an agent that was never hatched
    const runner = new AppPageRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "calculator-app",
      runId: "eval-apppage-prehatch",
    });

    // WHEN/THEN resolving the app page rejects before touching the container
    await expect(agent.resolveAppPage!()).rejects.toThrow(
      /has not been hatched/,
    );
  });

  test("newConversation runs `vellum exec assistant conversations new` and updates the conversation key", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-newconvo",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const beforeKey = agent.conversationKey;

    await agent.newConversation!();

    const newConvoRun = runner.runs.at(-1)!;
    expect(newConvoRun.command).toBe("vellum");
    expect(newConvoRun.args).toEqual([
      "exec",
      "eval-newconvo",
      "--",
      "assistant",
      "conversations",
      "new",
    ]);
    expect(agent.conversationKey).toBe("generated-key-123");
    expect(agent.conversationKey).not.toBe(beforeKey);
  });

  test("newConversation throws if no conversation key is found in the CLI output", async () => {
    // Custom runner: same shape as FakeRunner but returns stdout
    // that lacks the `conversation key:` token, simulating a CLI
    // version drift or a malformed output line.
    class SilentRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, opts });
        if (args[0] === "exec" && args.includes("conversations")) {
          return {
            exitCode: 0,
            stdout: "Created conversation: (no-key)\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }
    const runner = new SilentRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-newconvo-bad",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    await expect(agent.newConversation!()).rejects.toThrow(
      /did not return a conversation key/,
    );
  });

  test("newConversation kills the cached events process and the next events() respawns against the new conversation key", async () => {
    // Regression guard for the two-conversation SSE caching bug
    // (see vellum.ts → `events()` + `newConversation()`).
    //
    // Before the fix:
    //   - events() memoized the spawned process by setting
    //     `this.eventsProcess ??= ...` against the ingest
    //     conversation key
    //   - newConversation() rotated `this.conversationKey` but never
    //     touched `eventsProcess`
    //   - the second events() call returned the cached iterable, still
    //     bound to the ingest process, so `runIngestAsk`'s question
    //     turn drained the WRONG conversation's stream and timed out
    //     with "zero events"
    //
    // The fix invalidates the cache; this test pins both halves
    // (cached process killed + new spawn observed) to a unit-level
    // assertion so a future refactor can't silently regress.
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-events-rotation",
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const ingestKey = agent.conversationKey;

    // Subscribe to events for conversation A. We don't iterate — the
    // assertions below operate on the spawn record and the cached
    // process flag, not on consumed stream values.
    agent.events();
    expect(runner.spawns.at(-1)?.args).toEqual([
      "events",
      "eval-events-rotation",
      "--conversation-key",
      ingestKey,
      "--json",
    ]);
    const ingestProcess = runner.process;
    expect(ingestProcess.killed).toBe(false);
    const spawnsBeforeRotate = runner.spawns.length;

    // Rotate. The contract this test is enforcing: a successful
    // newConversation() MUST kill the cached events process AND
    // clear the slot, so the next events() call respawns against the
    // rotated key.
    await agent.newConversation!();
    const questionKey = agent.conversationKey;
    expect(questionKey).not.toBe(ingestKey);
    expect(ingestProcess.killed).toBe(true);

    // Subscribe again — should spawn a fresh process bound to the new
    // key. The shared FakeProcess instance is reused, but the spawn
    // record is what we care about.
    agent.events();
    expect(runner.spawns.length).toBe(spawnsBeforeRotate + 1);
    expect(runner.spawns.at(-1)?.args).toEqual([
      "events",
      "eval-events-rotation",
      "--conversation-key",
      questionKey,
      "--json",
    ]);
  });

  test("newConversation throws when the agent has not been hatched", async () => {
    const runner = new FakeRunner();
    const agent = new VellumAgent({
      runner,
      profile,
      testId: "lme-v2",
      runId: "eval-newconvo-prehatch",
    });

    await expect(agent.newConversation!()).rejects.toThrow(
      /has not been hatched/,
    );
  });
});

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

function source(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe("normalizeVellumEventStream", () => {
  test("passes through assistant_text_delta events unchanged", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "assistant_text_delta", text: "hello" } },
          { message: { type: "assistant_text_delta", text: " world" } },
        ]),
      ),
    );
    expect(out).toEqual([
      { message: { type: "assistant_text_delta", text: "hello" } },
      { message: { type: "assistant_text_delta", text: " world" } },
    ]);
  });

  test("passes through message_chunk events unchanged", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([{ message: { type: "message_chunk", chunk: "hi" } }]),
      ),
    );
    expect(out).toEqual([{ message: { type: "message_chunk", chunk: "hi" } }]);
  });

  test("strips text on user_message_echo (the iter-2 echo bug)", async () => {
    // The exact failure mode from the iter-2 timeline-recall eval: the
    // Vellum daemon broadcasts `user_message_echo` with the user's own
    // outbound on `message.text`. A naive `text ?? chunk` in the runner
    // captured it as the assistant's first reply, 72 ms after send.
    // Adapter-level normalization must clear `text` so it can never
    // land as transcript.
    const out = await collect(
      normalizeVellumEventStream(
        source([
          {
            message: {
              type: "user_message_echo",
              text: "What date did I mention my partner's peanut allergy?",
            },
          },
        ]),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.message.type).toBe("user_message_echo");
    expect(out[0]?.message.text).toBeUndefined();
    expect(out[0]?.message.chunk).toBeUndefined();
  });

  test("strips text/chunk on tool, thinking, error, complete, usage events but preserves them on the stream", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "tool_use_start", toolName: "shell" } },
          { message: { type: "tool_input_delta", content: '{"cmd": "ls' } },
          { message: { type: "tool_output_chunk", chunk: "file.txt" } },
          { message: { type: "assistant_thinking_delta", thinking: "hmm" } },
          { message: { type: "error", message: "boom" } },
          { message: { type: "message_complete" } },
          {
            message: {
              type: "assistant_usage",
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        ]),
      ),
    );
    expect(out).toHaveLength(7);
    for (const event of out) {
      expect(event.message.text).toBeUndefined();
      expect(event.message.chunk).toBeUndefined();
    }
    // Other fields preserved so the artifact log + metrics layer can
    // still inspect tool args / thinking / usage records.
    expect(out[0]?.message.toolName).toBe("shell");
    expect(out[3]?.message.thinking).toBe("hmm");
    expect(out[6]?.message.input_tokens).toBe(100);
  });

  test("strips when `type` field is missing or non-string (defensive — unknown shapes shouldn't slip through as transcript)", async () => {
    const out = await collect(
      normalizeVellumEventStream(
        source([
          { message: { type: "", text: "nope" } },
          // @ts-expect-error -- intentionally malformed
          { message: { text: "also nope" } },
        ]),
      ),
    );
    expect(out[0]?.message.text).toBeUndefined();
    expect(out[1]?.message.text).toBeUndefined();
  });
});

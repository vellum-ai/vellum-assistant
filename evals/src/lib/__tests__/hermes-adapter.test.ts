import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  HermesAgent,
  DEFAULT_HERMES_IMAGE,
  DERIVED_HERMES_IMAGE,
  EXEC_PATH,
  HERMES_CA_TRUST_ENV_FLAGS,
  HERMES_TRANSCRIPT_EVENT_TYPE,
  selectProviderEnvFlags,
  selectInferenceSelection,
  inferenceEnvFlags,
  synthesizeHermesTurnEvent,
  buildHermesTurnPrompt,
} from "../adapters/hermes";
import { AgentEventCollector } from "../runner/event-collector";
import {
  HERMES_EVAL_SESSION_SOURCE,
  HERMES_STATE_DB_PATH,
} from "../adapters/hermes-seed";
import {
  DEFAULT_ALLOW_HOSTS,
  DEFAULT_EMBEDDING_ALLOW_HOSTS,
} from "../egress/docker-jail";
import { runArtifacts } from "../metrics";
import type { Profile } from "../profile";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
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
  // Hermes turns are single-shot: there is no live event subprocess to
  // spawn, so nothing consumes this stream. Kept only to satisfy the
  // CommandRunner interface for the unrelated egress-jail plumbing.
  stdout = lines([]);
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
    stdin?: string;
  }> = [];
  readonly spawns: Array<{ command: string; args: string[] }> = [];
  readonly process = new FakeProcess();

  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    this.runs.push({ command, args, stdin: opts?.stdin });
    // Mirror what the in-container python helper prints on success so
    // assertSuccess sees a clean exit and the seed helper's stdout
    // assertions stay realistic.
    const isSeed = args[0] === "exec" && args.includes("python3");
    if (isSeed) {
      return {
        exitCode: 0,
        stdout:
          '{"session_id": "evals_timeline-recall_eval-hermes-seed", "messages": 2}\n',
        stderr: "",
      };
    }
    // A `hermes -z "<prompt>"` send prints only the final assistant text.
    // Echo the prompt (with a trailing newline the real CLI appends) so
    // turn-event synthesis and trailing-whitespace trimming are exercised.
    const zIdx = args.indexOf("-z");
    if (zIdx !== -1) {
      return { exitCode: 0, stdout: `reply: ${args[zIdx + 1]}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }

  spawn(command: string, args: string[]): SpawnedProcess {
    this.spawns.push({ command, args });
    return this.process;
  }
}

const profile: Profile = {
  id: "hermes-default",
  manifest: {
    species: "hermes",
    setup: ["hermes plugins install simple-memory"],
  },
  workspaceDir: "/profiles/hermes-default/workspace",
};

async function preStageRecordingCa(runId: string): Promise<void> {
  const runDir = runArtifacts(runId).runDir;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");
}

/**
 * The `docker run` that starts the Hermes container. Owner-mode issues two
 * `docker run -d` calls per hatch (the jail, then Hermes born into it), so
 * match on the Hermes species label rather than the first `run -d`.
 */
function hermesDockerRun(runner: FakeRunner): {
  command: string;
  args: string[];
  stdin?: string;
} {
  const run = runner.runs.find(
    (r) =>
      r.command === "docker" &&
      r.args[0] === "run" &&
      r.args.includes("evals.vellum.ai/species=hermes"),
  );
  if (!run) throw new Error("no Hermes `docker run` was recorded");
  return run;
}

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

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    expect(agent.id).toBe("eval-hermes-1");
    expect(agent.conversationKey).toBe("evals:timeline-recall:eval-hermes-1");

    const calls = runner.runs.map((r) => [r.command, ...r.args]);

    // 1. The derived image is built first, while the build still has open
    //    egress, baking the lazy provider SDK from the pinned base.
    expect(calls[0]).toEqual([
      "docker",
      "build",
      "-t",
      DERIVED_HERMES_IMAGE,
      "--build-arg",
      `HERMES_BASE=${DEFAULT_HERMES_IMAGE}`,
      expect.stringContaining("hermes-image"),
    ]);

    // 2. The recording jail is created BEFORE the Hermes container so it
    //    owns the namespace Hermes is born into. Pre-clean of the Hermes
    //    container precedes its own `docker run`.
    const jailRunIdx = calls.findIndex(
      (c) =>
        c[0] === "docker" &&
        c[1] === "run" &&
        c.includes("eval-hermes-1-egress-jail"),
    );
    const hermesRunIdx = calls.findIndex(
      (c) =>
        c[0] === "docker" &&
        c[1] === "run" &&
        c.includes("evals.vellum.ai/species=hermes"),
    );
    const hermesPreCleanIdx = calls.findIndex(
      (c) =>
        c[0] === "docker" &&
        c[1] === "rm" &&
        c.includes("eval-hermes-1-hermes"),
    );
    expect(jailRunIdx).toBeGreaterThan(0);
    expect(hermesRunIdx).toBeGreaterThan(jailRunIdx);
    expect(hermesPreCleanIdx).toBeLessThan(hermesRunIdx);

    // Hermes never embeds locally, so its jail stays on the model-provider
    // default and the embedder's npm/HuggingFace download hosts are absent
    // from the allowlist — Hermes can't make unmetered asset egress, which
    // keeps cross-species cost comparisons honest.
    const allowHostsArg = calls[jailRunIdx].find((arg) =>
      arg.startsWith("ALLOW_HOSTS="),
    );
    expect(allowHostsArg).toBe(`ALLOW_HOSTS=${DEFAULT_ALLOW_HOSTS.join(",")}`);
    for (const host of DEFAULT_EMBEDDING_ALLOW_HOSTS) {
      expect(allowHostsArg).not.toContain(host);
    }

    // 3. Hermes is born into the jail's netns and runs the derived image.
    expect(calls[hermesRunIdx]).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "eval-hermes-1-hermes",
      "--network",
      "container:eval-hermes-1-egress-jail",
      "--label",
      "evals.vellum.ai/species=hermes",
      "-e",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "-e",
      "SSL_CERT_DIR=/etc/ssl/certs",
      "-e",
      "HERMES_DISABLE_LAZY_INSTALLS=1",
      DERIVED_HERMES_IMAGE,
      "gateway",
      "run",
    ]);

    // 4. The interception CA is trusted (cp + update-ca-certificates) after
    //    the container starts and before any turn.
    const caCpIdx = calls.findIndex((c) => c[0] === "docker" && c[1] === "cp");
    const caUpdateIdx = calls.findIndex((c) =>
      c.includes("update-ca-certificates"),
    );
    expect(caCpIdx).toBeGreaterThan(hermesRunIdx);
    expect(caUpdateIdx).toBeGreaterThan(caCpIdx);

    // 5. The workspace dir is created (root, chowned to the gateway user).
    const workspaceIdx = calls.findIndex(
      (c) =>
        c[0] === "docker" &&
        c[1] === "exec" &&
        c.some((a) => a.includes('mkdir -p "/workspace"')),
    );
    expect(workspaceIdx).toBeGreaterThan(caUpdateIdx);

    // 6. The setup command runs last, once the CA + workspace are in place.
    const setupIdx = calls.findIndex((c) =>
      c.includes("hermes plugins install simple-memory"),
    );
    expect(setupIdx).toBeGreaterThan(workspaceIdx);
    expect(calls[setupIdx]).toEqual([
      "docker",
      "exec",
      "--env",
      `PATH=${EXEC_PATH}`,
      "eval-hermes-1-hermes",
      "sh",
      "-c",
      "hermes plugins install simple-memory",
    ]);
    expect(runner.spawns).toEqual([]);

    // Driving a turn: `send` runs one `hermes -z` and the synthesized
    // transcript event surfaces on the `events()` stream — no live event
    // subprocess is ever spawned.
    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );
    await agent.send({ content: "hello hermes" });
    const events = await collector.collectUntilQuiet({ quietMs: 5, maxMs: 50 });
    expect(runner.spawns).toEqual([]);
    expect(events).toEqual([
      { message: { type: "message_chunk", chunk: "reply: hello hermes" } },
    ]);

    // The send invoked `hermes -z "<prompt>"` as the unprivileged gateway
    // user so memory writes stay gateway-owned, and ran in `/workspace` so
    // the agent's file tools resolve staged files by bare name.
    expect(runner.runs.at(-1)).toMatchObject({
      command: "docker",
      args: [
        "exec",
        "--user",
        "hermes",
        "--env",
        `PATH=${EXEC_PATH}`,
        "--workdir",
        "/workspace",
        "eval-hermes-1-hermes",
        "hermes",
        "-z",
        "hello hermes",
      ],
    });
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

    await preStageRecordingCa(agent.id);
    await agent.hatch();
    await agent.send({ content: "hello hermes" });

    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    // The custom image is the BASE the derived image is built from.
    const buildCall = calls.find(
      (c) =>
        c[0] === "docker" &&
        c[1] === "build" &&
        c.includes(DERIVED_HERMES_IMAGE),
    )!;
    expect(buildCall).toContain("--build-arg");
    expect(buildCall).toContain("HERMES_BASE=nousresearch/hermes-agent:v0.42");
    // The derived image + custom daemonArgs land at the tail of the Hermes
    // `docker run` invocation.
    expect(hermesDockerRun(runner).args.slice(-4)).toEqual([
      DERIVED_HERMES_IMAGE,
      "serve",
      "--port",
      "1234",
    ]);
    expect(calls.at(-1)).toEqual([
      "docker",
      "exec",
      "--user",
      "hermes",
      "--env",
      `PATH=${EXEC_PATH}`,
      "--workdir",
      "/workspace",
      "eval-hermes-custom-hermes",
      "hermesctl",
      "-z",
      "hello hermes",
    ]);
  });

  test("seed-conversation injects rows directly into the container's state.db", async () => {
    // Seeding must (1) write to /opt/data/state.db via `docker exec -i
    // python3 -c <script>`, (2) pipe the messages JSON payload on
    // stdin (no command-line escaping of user content, and stdin
    // separated from the script body so `json.load(sys.stdin)` works),
    // (3) re-point conversationKey at the newly-minted session id, and
    // (4) never invoke the model — no `hermes message` calls between
    // hatch and seed.
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-seed",
      processEnv: {},
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const runsBeforeSeed = runner.runs.length;

    await agent.runSetupCommand({
      type: "seed-conversation",
      messages: [
        { role: "user", content: "remember this exact note" },
        { role: "assistant", content: "noted" },
      ],
    });

    // Exactly one extra `docker exec` was emitted — the seed call.
    expect(runner.runs.length).toBe(runsBeforeSeed + 1);
    const seedCall = runner.runs[runsBeforeSeed]!;
    expect(seedCall.command).toBe("docker");

    // The script body is passed as a single argv element to `python3
    // -c`. Stdin is reserved for the JSON payload — `python3 -` would
    // consume stdin as the program body and leave `json.load(sys.stdin)`
    // staring at EOF (the bug we shipped in PR #31106 iter-2 and saw in
    // the wild as `JSONDecodeError: Expecting value: line 1 column 1`).
    // The seed exec runs as `--user hermes` (the gateway's unprivileged
    // user, not the default root) so state.db and its WAL/SHM files stay
    // gateway-owned — a root-owned state.db would block the gateway from
    // writing its schema and silently drop it to JSONL.
    expect(seedCall.args[0]).toBe("exec");
    expect(seedCall.args[1]).toBe("-i");
    expect(seedCall.args[2]).toBe("--user");
    expect(seedCall.args[3]).toBe("hermes");
    expect(seedCall.args[4]).toBe("eval-hermes-seed-hermes");
    expect(seedCall.args[5]).toBe("python3");
    expect(seedCall.args[6]).toBe("-c");
    const script = seedCall.args[7] ?? "";
    expect(script).toContain("INSERT INTO messages");
    expect(script).toContain("INSERT OR IGNORE INTO sessions");
    expect(script).toContain("json.load(sys.stdin)");
    // The schema-wait probe must be read-only so it never creates (and
    // thus never root-poisons) state.db before the gateway does.
    expect(script).toContain("?mode=ro");
    expect(seedCall.args.length).toBe(8);

    // stdin carries ONLY the JSON payload now — no script prefix, no
    // separator newline. The payload has the messages, the target DB
    // path, and the session id we'll use as the new conversationKey.
    const stdin = seedCall.stdin ?? "";
    const payload = JSON.parse(stdin);
    expect(payload).toEqual({
      db_path: HERMES_STATE_DB_PATH,
      messages: [
        { role: "user", content: "remember this exact note" },
        { role: "assistant", content: "noted" },
      ],
      schema_wait_timeout_seconds: 30,
      session_id: "evals_timeline-recall_eval-hermes-seed",
      source: HERMES_EVAL_SESSION_SOURCE,
      title: "evals seed: timeline-recall",
    });

    // conversationKey now routes subsequent send/events at the seeded
    // session id, not the deterministic-default key.
    expect(agent.conversationKey).toBe(
      "evals_timeline-recall_eval-hermes-seed",
    );

    // No `hermes -z ...` was issued — seeding writes history directly and
    // never invokes the model.
    const sendCalls = runner.runs.filter(
      (r) =>
        r.command === "docker" &&
        r.args.includes("exec") &&
        r.args.includes("-z"),
    );
    expect(sendCalls).toEqual([]);
  });

  test("seed-conversation refuses to run before hatch", async () => {
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-prehatch",
      processEnv: {},
    });

    await expect(
      agent.runSetupCommand({
        type: "seed-conversation",
        messages: [{ role: "user", content: "noop" }],
      }),
    ).rejects.toThrow(/has not been hatched/);

    // No docker side effects fired.
    expect(runner.runs).toEqual([]);
  });

  test("hatch creates the workspace dir owned by the gateway user", async () => {
    // GIVEN a freshly-hatched Hermes agent
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "restaurant-pnl-spend",
      runId: "eval-hermes-ws",
      processEnv: {},
    });

    // WHEN it hatches
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // THEN it mkdir's /workspace as root and chowns it to the hermes user
    // so `send`'s --workdir resolves and staged files can be written there.
    const mkdirWs = runner.runs.find(
      (r) =>
        r.args[0] === "exec" &&
        r.args.includes("root") &&
        r.args.some(
          (a) => typeof a === "string" && a.includes('mkdir -p "/workspace"'),
        ),
    );
    expect(mkdirWs).toBeDefined();
    expect(mkdirWs?.args.at(-1)).toContain('chown hermes "/workspace"');
  });

  test("stage-workspace-file pipes the payload into /workspace as the hermes user", async () => {
    // GIVEN a hatched Hermes agent
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "restaurant-pnl-spend",
      runId: "eval-hermes-stage",
      processEnv: {},
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const baseline = runner.runs.length;

    // WHEN a file is staged into the workspace
    await agent.runSetupCommand({
      type: "stage-workspace-file",
      path: "restaurant-pnl.csv",
      content: "Category,Amount (USD)\nLabor,48200\n",
    });
    const newRuns = runner.runs.slice(baseline);

    // THEN it mkdir's the parent as the hermes user, then `cp /dev/stdin`'s
    // the payload (piped on stdin, never on the command line) to the target.
    expect(newRuns[0].args).toEqual([
      "exec",
      "--user",
      "hermes",
      "eval-hermes-stage-hermes",
      "mkdir",
      "-p",
      "/workspace",
    ]);
    expect(newRuns[1].args).toEqual([
      "exec",
      "-i",
      "--user",
      "hermes",
      "eval-hermes-stage-hermes",
      "cp",
      "/dev/stdin",
      "/workspace/restaurant-pnl.csv",
    ]);
    expect(newRuns[1].stdin).toBe("Category,Amount (USD)\nLabor,48200\n");
  });

  test("seed-conversation surfaces the in-container error when state.db write fails", async () => {
    class BrokenSeedRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, stdin: opts?.stdin });
        if (args[0] === "exec" && args.includes("python3")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              'Traceback (most recent call last):\n  File "<stdin>", line 22\n    OperationalError: database is locked\n',
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }
    const runner = new BrokenSeedRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-seed-fail",
      processEnv: {},
    });

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    await expect(
      agent.runSetupCommand({
        type: "seed-conversation",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(/database is locked/);

    // conversationKey stays at the deterministic-default value on
    // failure — no half-rotated state.
    expect(agent.conversationKey).toBe(
      "evals:timeline-recall:eval-hermes-seed-fail",
    );
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

    await preStageRecordingCa(agent.id);
    await agent.hatch();
    agent.events();
    await agent.send({ content: "hello" });
    await agent.shutdown();

    // The send is one `hermes -z` exec; shutdown then tears down in
    // owner-mode order — the Hermes tenant is removed BEFORE the jail that
    // owns the namespace it joined (the owner must outlive its tenants).
    // No event subprocess is spawned to kill.
    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    expect(calls.at(-4)).toEqual([
      "docker",
      "exec",
      "--user",
      "hermes",
      "--env",
      `PATH=${EXEC_PATH}`,
      "--workdir",
      "/workspace",
      "eval-hermes-2-hermes",
      "hermes",
      "-z",
      "hello",
    ]);
    const hermesRmIdx = calls.findIndex(
      (c, i) =>
        i >= calls.length - 3 &&
        c[0] === "docker" &&
        c[1] === "rm" &&
        c.includes("eval-hermes-2-hermes"),
    );
    const jailRmIdx = calls.findIndex(
      (c, i) =>
        i >= calls.length - 3 &&
        c[0] === "docker" &&
        c[1] === "rm" &&
        c.includes("eval-hermes-2-egress-jail"),
    );
    expect(hermesRmIdx).toBeGreaterThan(0);
    expect(jailRmIdx).toBeGreaterThan(hermesRmIdx);
    expect(runner.spawns).toEqual([]);
  });

  test("threads prior live turns into each one-shot prompt", async () => {
    /**
     * A `hermes -z` shot is stateless, so the adapter must replay the
     * conversation so far into later prompts for turn N to see turns 1..N-1.
     */
    // GIVEN a hatched Hermes agent that has taken one turn
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-thread",
      processEnv: {},
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    agent.events();
    await agent.send({ content: "remember the codeword BANANA" });

    // WHEN a second message is sent
    await agent.send({ content: "what was the codeword?" });

    // THEN the second `-z` prompt replays turn 1 (the FakeRunner echoes
    // `reply: <prompt>`, so turn 1's answer is `reply: remember ...`) and
    // carries the new message, while the first shot sent the raw message.
    const zPrompts = runner.runs
      .filter((r) => r.command === "docker" && r.args.includes("-z"))
      .map((r) => r.args[r.args.indexOf("-z") + 1]);
    expect(zPrompts).toHaveLength(2);
    expect(zPrompts[0]).toBe("remember the codeword BANANA");
    expect(zPrompts[1]).toContain("User: remember the codeword BANANA");
    expect(zPrompts[1]).toContain(
      "Assistant: reply: remember the codeword BANANA",
    );
    expect(zPrompts[1]).toContain("what was the codeword?");

    await agent.shutdown();
  });

  test("tears down the jail but does not re-remove Hermes when its start fails", async () => {
    class FailingRunner extends FakeRunner {
      override async run(
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<CommandResult> {
        this.runs.push({ command, args, stdin: opts?.stdin });
        // Fail the Hermes container start (the `docker run` carrying the
        // species label); the jail start before it succeeds.
        if (
          command === "docker" &&
          args[0] === "run" &&
          args.includes("evals.vellum.ai/species=hermes")
        ) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Unable to find image 'vellum-evals-hermes:local'",
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

    await preStageRecordingCa(agent.id);
    await expect(agent.hatch()).rejects.toThrow(
      "Unable to find image 'vellum-evals-hermes:local'",
    );

    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    // The Hermes container never started (its `docker run` failed), so the
    // only `rm -f` for it is the pre-clean — no spurious follow-up retire.
    const hermesRms = calls.filter(
      (c) =>
        c[0] === "docker" &&
        c[1] === "rm" &&
        c.includes("image-missing-hermes"),
    );
    expect(hermesRms).toHaveLength(1);
    // The jail (created first, owns the netns) is still torn down on the
    // error path.
    expect(
      calls.some(
        (c) =>
          c[0] === "docker" &&
          c[1] === "rm" &&
          c.includes("image-missing-egress-jail"),
      ),
    ).toBe(true);
  });

  test("refuses to hatch a non-hermes profile", async () => {
    const runner = new FakeRunner();
    const wrongProfile: Profile = {
      id: "vellum-default",
      manifest: { species: "vellum" },
      workspaceDir: "/profiles/vellum-default/workspace",
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

    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const dockerRun = hermesDockerRun(runner);
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
    const imageIdx = dockerRun.args.indexOf(DERIVED_HERMES_IMAGE);
    expect(imageIdx).toBeGreaterThan(dockerRun.args.lastIndexOf("-e"));
    expect(dockerRun.args.slice(imageIdx + 1)).toEqual(["gateway", "run"]);
  });

  test("points Hermes's Python TLS stack at the jail-augmented system CA bundle", async () => {
    // GIVEN a Hermes agent (Python httpx trusts certifi, not the system store
    // the egress jail writes the mitmproxy CA into).
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-ca",
      processEnv: { ANTHROPIC_API_KEY: "anthropic-test-value" },
    });

    // WHEN it hatches the daemon container.
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // THEN the daemon `docker run` sets SSL_CERT_FILE/SSL_CERT_DIR so httpx
    // loads the jail-augmented system bundle (public CAs + mitmproxy CA)
    // instead of certifi, and the flags sit before the image so they apply
    // to the container (and every inheriting `docker exec` turn).
    const dockerRun = hermesDockerRun(runner);
    const flat = dockerRun.args.join(" ");
    expect(flat).toContain(HERMES_CA_TRUST_ENV_FLAGS.join(" "));
    expect(flat).toContain("SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt");
    const lastCaEnvIdx = dockerRun.args.lastIndexOf(
      "SSL_CERT_DIR=/etc/ssl/certs",
    );
    expect(dockerRun.args.indexOf(DERIVED_HERMES_IMAGE)).toBeGreaterThan(
      lastCaEnvIdx,
    );
  });

  test("bakes provider deps into the derived image instead of warming up at runtime", async () => {
    // GIVEN a Hermes agent keyed on ANTHROPIC_API_KEY (the native Anthropic
    // SDK is a Hermes lazy-install that would otherwise hang under the
    // fail-closed jail).
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-baked",
      processEnv: { ANTHROPIC_API_KEY: "anthropic-test-value" },
    });

    // WHEN it hatches.
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    // THEN no runtime lazy-install warm-up exec is issued — the SDK is
    // baked into the derived image at build time instead, so a jailed turn
    // never reaches PyPI.
    expect(
      calls.some((c) =>
        c.some((a) => a.includes("from tools.lazy_deps import ensure")),
      ),
    ).toBe(false);
    // AND the derived image is built from the pinned base via --build-arg.
    const buildCall = calls.find(
      (c) =>
        c[0] === "docker" &&
        c[1] === "build" &&
        c.includes(DERIVED_HERMES_IMAGE),
    )!;
    expect(buildCall).toContain("--build-arg");
    expect(buildCall).toContain(`HERMES_BASE=${DEFAULT_HERMES_IMAGE}`);
    // AND the daemon still disables runtime lazy installs as a backstop so an
    // unbaked optional dep degrades gracefully rather than wedging the run.
    expect(hermesDockerRun(runner).args).toContain(
      "HERMES_DISABLE_LAZY_INSTALLS=1",
    );
  });

  test("never issues a runtime warm-up exec regardless of forwarded provider key", async () => {
    // GIVEN a Hermes agent with only OPENAI_API_KEY (the OpenAI SDK ships
    // pre-installed, so nothing needs warming).
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-no-warmup",
      processEnv: { OPENAI_API_KEY: "openai-test-value" },
    });

    // WHEN it hatches.
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // THEN no lazy-install warm-up exec is issued, but the daemon still
    // disables runtime lazy installs.
    const calls = runner.runs.map((r) => [r.command, ...r.args]);
    expect(
      calls.some((c) =>
        c.some((a) => a.includes("from tools.lazy_deps import ensure")),
      ),
    ).toBe(false);
    expect(hermesDockerRun(runner).args).toContain(
      "HERMES_DISABLE_LAZY_INSTALLS=1",
    );
  });

  test("pins the inference provider + model to the forwarded key's native backend", async () => {
    // GIVEN a Hermes agent keyed on ANTHROPIC_API_KEY. Hermes's provider
    // auto-resolution ignores that key and would fall back to openrouter (a
    // blocked host under the egress jail).
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-pin",
      processEnv: { ANTHROPIC_API_KEY: "anthropic-test-value" },
    });

    // WHEN it hatches.
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // THEN the daemon `docker run` pins provider + model to the native
    // Anthropic backend (an allowlisted host), so no turn probes openrouter,
    // and both flags sit before the image so they apply to every `hermes -z`.
    const dockerRun = hermesDockerRun(runner);
    const flat = dockerRun.args.join(" ");
    expect(flat).toContain("HERMES_INFERENCE_PROVIDER=anthropic");
    expect(flat).toContain("HERMES_INFERENCE_MODEL=claude-sonnet-4-6");
    const lastInferenceIdx = dockerRun.args.lastIndexOf(
      "HERMES_INFERENCE_MODEL=claude-sonnet-4-6",
    );
    expect(dockerRun.args.indexOf(DERIVED_HERMES_IMAGE)).toBeGreaterThan(
      lastInferenceIdx,
    );
  });

  test("omits the inference pin when no recognized provider key is forwarded", async () => {
    // GIVEN a Hermes agent with no forwarded provider key.
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-no-pin",
      processEnv: {},
    });

    // WHEN it hatches.
    await preStageRecordingCa(agent.id);
    await agent.hatch();

    // THEN no HERMES_INFERENCE_* flags are set — Hermes keeps its own
    // configured defaults rather than being forced onto a provider with no
    // matching key.
    expect(hermesDockerRun(runner).args.join(" ")).not.toContain(
      "HERMES_INFERENCE_",
    );
  });

  test("selectInferenceSelection picks the first forwarded key in priority order", () => {
    // Anthropic wins when present, even alongside other keys.
    expect(
      selectInferenceSelection({
        ANTHROPIC_API_KEY: "present",
        GEMINI_API_KEY: "present",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });

    // Falls through to the next forwarded provider when Anthropic is absent.
    expect(selectInferenceSelection({ GEMINI_API_KEY: "present" })).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(selectInferenceSelection({ GOOGLE_API_KEY: "present" })).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    // OPENAI_API_KEY has no native API-key backend in the pinned Hermes
    // image (only the OAuth-based openai-codex provider), so it is not
    // pinnable — selection falls through and Hermes resolves normally.
    expect(
      selectInferenceSelection({ OPENAI_API_KEY: "present" }),
    ).toBeUndefined();

    // No recognized key → undefined (Hermes keeps its defaults).
    expect(selectInferenceSelection({})).toBeUndefined();
    expect(selectInferenceSelection({ ANTHROPIC_API_KEY: "" })).toBeUndefined();

    // inferenceEnvFlags renders both flags together, or nothing.
    expect(
      inferenceEnvFlags({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    ).toEqual([
      "-e",
      "HERMES_INFERENCE_PROVIDER=anthropic",
      "-e",
      "HERMES_INFERENCE_MODEL=claude-sonnet-4-6",
    ]);
    expect(inferenceEnvFlags(undefined)).toEqual([]);
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

describe("synthesizeHermesTurnEvent", () => {
  test("maps one-shot stdout to a single message_chunk transcript event", () => {
    expect(synthesizeHermesTurnEvent("the answer is March 14")).toEqual({
      message: {
        type: HERMES_TRANSCRIPT_EVENT_TYPE,
        chunk: "the answer is March 14",
      },
    });
  });

  test("trims the trailing newline the CLI appends without touching inner text", () => {
    expect(
      synthesizeHermesTurnEvent("line one\nline two\n\n").message.chunk,
    ).toBe("line one\nline two");
  });

  test("still produces an event for an empty answer so the turn isn't read as a dead stream", () => {
    expect(synthesizeHermesTurnEvent("").message.chunk).toBe("");
  });
});

describe("HermesAgent single-shot event synthesis", () => {
  test("each send pushes exactly one turn event onto a reused subscription (multi-turn)", async () => {
    // GIVEN a hatched agent with a single events() subscription, mirroring
    // the simulator runner which subscribes once and drains per turn.
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-multiturn",
      processEnv: {},
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );

    // WHEN two turns are sent through the same subscription.
    await agent.send({ content: "first" });
    const turn1 = await collector.collectUntilQuiet({ quietMs: 5, maxMs: 50 });
    await agent.send({ content: "second" });
    const turn2 = await collector.collectUntilQuiet({ quietMs: 5, maxMs: 50 });

    // THEN each turn surfaces exactly one event for its own one-shot answer —
    // the subscription stays live across turns and never bleeds turn 1's
    // event into turn 2. Turn 1 (no prior turns) echoes the raw message;
    // turn 2's prompt threads the conversation so far, so its answer reflects
    // the new message rather than turn 1's standalone event.
    expect(turn1).toEqual([
      { message: { type: "message_chunk", chunk: "reply: first" } },
    ]);
    expect(turn2).toHaveLength(1);
    expect(turn2[0].message.type).toBe("message_chunk");
    expect(turn2[0].message.chunk).toContain("second");

    // AND every turn is a `hermes -z` one-shot — no live event subprocess.
    const sends = runner.runs.filter((r) => r.args.includes("-z"));
    expect(sends).toHaveLength(2);
    expect(runner.spawns).toEqual([]);
  });

  test("a parked subscription unblocks at shutdown instead of hanging", async () => {
    // GIVEN a subscription with no buffered events (no send yet).
    const runner = new FakeRunner();
    const agent = new HermesAgent({
      runner,
      profile,
      testId: "timeline-recall",
      runId: "eval-hermes-drain-eof",
      processEnv: {},
    });
    await preStageRecordingCa(agent.id);
    await agent.hatch();
    const iterator = agent.events()[Symbol.asyncIterator]();
    const pending = iterator.next();

    // WHEN the agent shuts down while a consumer is parked on next().
    await agent.shutdown();

    // THEN the parked consumer resolves as done rather than hanging.
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });
});

describe("buildHermesTurnPrompt", () => {
  test("sends the raw message on the first turn", () => {
    /**
     * A single-turn test should read as a plain question, not a wrapped
     * transcript, so the first turn (no prior turns) passes the message
     * straight through.
     */
    // GIVEN no prior turns
    // WHEN building the prompt for the first message
    const prompt = buildHermesTurnPrompt(
      [],
      "What was my largest spend category?",
    );

    // THEN the message is sent verbatim
    expect(prompt).toBe("What was my largest spend category?");
  });

  test("replays prior turns as labeled context before the new message", () => {
    /**
     * Later turns must carry the conversation so far so the stateless shot
     * can answer with context.
     */
    // GIVEN a one-exchange conversation so far
    const priorTurns = [
      { role: "user" as const, content: "I uploaded my P&L." },
      {
        role: "assistant" as const,
        content: "Got it, I read restaurant-pnl.csv.",
      },
    ];

    // WHEN building the prompt for the next message
    const prompt = buildHermesTurnPrompt(
      priorTurns,
      "Which category was largest?",
    );

    // THEN the transcript is replayed with role labels and the new message follows
    expect(prompt).toContain("User: I uploaded my P&L.");
    expect(prompt).toContain("Assistant: Got it, I read restaurant-pnl.csv.");
    expect(prompt).toContain("Which category was largest?");
    // AND the prior turns precede the new message
    expect(prompt.indexOf("I uploaded my P&L.")).toBeLessThan(
      prompt.indexOf("Which category was largest?"),
    );
  });
});

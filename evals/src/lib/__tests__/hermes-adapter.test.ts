import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../adapter";
import {
  HermesAgent,
  DEFAULT_HERMES_IMAGE,
  EXEC_PATH,
  normalizeHermesEventStream,
  selectProviderEnvFlags,
} from "../adapters/hermes";
import {
  HERMES_EVAL_SESSION_SOURCE,
  HERMES_STATE_DB_PATH,
} from "../adapters/hermes-seed";
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
    const stdout = isSeed
      ? '{"session_id": "evals_timeline-recall_eval-hermes-seed", "messages": 2}\n'
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

async function preStageRecordingCa(runId: string): Promise<void> {
  const runDir = runArtifacts(runId).runDir;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "mitmproxy-ca-cert.pem"), "fake-ca-pem");
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
    // Recording sidecar now includes build + run (detached) instead of rm + run (--rm)
    expect(calls[2]).toEqual([
      "docker",
      "rm",
      "-f",
      "eval-hermes-1-hermes-egress-jail",
    ]);
    // Build command
    expect(calls[3][0]).toBe("docker");
    expect(calls[3][1]).toBe("build");
    expect(calls[3][2]).toBe("-t");
    expect(calls[3][3]).toBe("vellum-evals-recording-jail:local");
    // Run command (detached with recording mount)
    expect(calls[4].slice(0, 6)).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "eval-hermes-1-hermes-egress-jail",
      "--network",
    ]);
    expect(calls[4]).toContain("container:eval-hermes-1-hermes");
    expect(calls[4]).toContain("--cap-add");
    expect(calls[4]).toContain("NET_ADMIN");
    expect(calls[4]).toContain("evals.vellum.ai/egress-recording=1");
    // Setup command (calls[5..6] are now CA install: docker cp + docker exec
    // update-ca-certificates; setup shifts to calls[7])
    expect(calls[7]).toEqual([
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

    await preStageRecordingCa(agent.id);
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

    // No `hermes message ...` was issued — seeding does not invoke the
    // model.
    const sendCalls = runner.runs.filter(
      (r) =>
        r.command === "docker" &&
        r.args.includes("exec") &&
        r.args.includes("message"),
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
            stderr:
              "Unable to find image 'nousresearch/hermes-agent:v2026.5.16'",
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
      "Unable to find image 'nousresearch/hermes-agent:v2026.5.16'",
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

    await preStageRecordingCa(agent.id);
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

async function collectHermesEvents(
  src: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of src) out.push(event);
  return out;
}

function hermesEventSource(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe("normalizeHermesEventStream", () => {
  test("passes through message_chunk events unchanged (the Hermes transcript event)", async () => {
    const out = await collectHermesEvents(
      normalizeHermesEventStream(
        hermesEventSource([
          { message: { type: "message_chunk", chunk: "hi from hermes" } },
          { message: { type: "message_chunk", chunk: " more text" } },
        ]),
      ),
    );
    expect(out).toEqual([
      { message: { type: "message_chunk", chunk: "hi from hermes" } },
      { message: { type: "message_chunk", chunk: " more text" } },
    ]);
  });

  test("passes through assistant_text_delta events unchanged (forward-compat with Vellum-style names)", async () => {
    const out = await collectHermesEvents(
      normalizeHermesEventStream(
        hermesEventSource([
          { message: { type: "assistant_text_delta", text: "hello" } },
        ]),
      ),
    );
    expect(out).toEqual([
      { message: { type: "assistant_text_delta", text: "hello" } },
    ]);
  });

  test("strips text on user_message_echo events", async () => {
    // Same echo-guard contract as Vellum. If a Hermes build ever
    // broadcasts a user-echo with `text`, the runner must not read it
    // as transcript.
    const out = await collectHermesEvents(
      normalizeHermesEventStream(
        hermesEventSource([
          {
            message: {
              type: "user_message_echo",
              text: "user's outbound text",
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

  test("strips text/chunk on tool, thinking, error, complete events but preserves them on the stream", async () => {
    const out = await collectHermesEvents(
      normalizeHermesEventStream(
        hermesEventSource([
          { message: { type: "tool_use_start", toolName: "shell" } },
          { message: { type: "tool_output_chunk", chunk: "file.txt" } },
          { message: { type: "assistant_thinking_delta", thinking: "hmm" } },
          { message: { type: "error", message: "boom" } },
          { message: { type: "message_complete" } },
        ]),
      ),
    );
    expect(out).toHaveLength(5);
    for (const event of out) {
      expect(event.message.text).toBeUndefined();
      expect(event.message.chunk).toBeUndefined();
    }
    expect(out[0]?.message.toolName).toBe("shell");
    expect(out[2]?.message.thinking).toBe("hmm");
  });
});

import { join } from "node:path";

import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../adapter";
import type { Profile } from "../profile";
import type { TestSetupCommand } from "../setup-command";
import { runArtifacts } from "../metrics";
import {
  applyDockerEgressJail,
  type DockerEgressJail,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
} from "../runtime/command-runner";
import { generateHermesEvalSessionId, seedHermesSession } from "./hermes-seed";

/**
 * Hermes adapter — runs a NousResearch Hermes Agent in Docker for eval runs.
 *
 * Hermes is a separate, external assistant species. Unlike Vellum, there is
 * no `vellum hatch hermes` host command and no host-side Hermes CLI that
 * manages container lifecycle for us. The adapter therefore drives Docker
 * directly:
 *
 *   - `docker run -d <image> gateway run` to spawn the Hermes container in
 *     persistent daemon mode (per the official Hermes Docker docs:
 *     https://hermes-agent.nousresearch.com/docs/user-guide/docker).
 *     Without `gateway run` the container's default entrypoint drops into
 *     interactive chat or the setup wizard and exits.
 *   - `-e <PROVIDER_KEY>` flags forwarded from the eval process env. Hermes
 *     normally reads keys from `/opt/data/.env`; we run with an ephemeral
 *     `/opt/data` per run so direct `-e` is the only way to get keys in.
 *   - `applyDockerEgressJail` to constrain outbound traffic to the same
 *     model-provider allowlist Vellum runs against. Keeps cross-species
 *     cost comparisons honest.
 *   - `docker exec --env PATH=...` for setup, send, and seed-conversation
 *     actions. The Hermes binary lives at `/opt/hermes/.venv/bin/hermes`;
 *     the official docs note it's NOT on PATH for `docker exec` sessions,
 *     so we set PATH explicitly.
 *
 * **A turn is a single-shot agent invocation.** Real Hermes has no
 * persistent `message`/`events` CLI pair to stream a conversation through.
 * Its non-interactive entrypoint is `hermes -z "<prompt>"`, which runs the
 * full agentic loop (tools, thinking, etc.) to completion and prints only
 * the final assistant text to stdout. So `send` runs one `hermes -z` per
 * user message and `events` synthesizes a single `message_chunk` transcript
 * event from that stdout — there is no live event subprocess to drain.
 *
 * **Cross-turn statefulness comes from Hermes's memory subsystem, not a
 * resumed session.** Each `-z` invocation is a fresh, stateless session;
 * `-z` ignores `--resume` entirely. Continuity instead flows through the
 * memory files under `/opt/data/memories/` (e.g. `USER.md`), which every
 * Hermes session auto-loads at start and auto-commits to at the end. The
 * adapter therefore does NOT track or chain session ids between turns —
 * memory is the system of record. (Known limitation: DB-injected seed rows
 * are not auto-indexed into memory, so a seeded prior conversation is not
 * reliably recalled unless the agent autonomously searches history. Tracked
 * as a follow-up; not addressed here.)
 *
 * The docker image, the daemon command, and the in-container CLI command
 * are constructor-overrideable via `dockerImage`, `daemonArgs`, and
 * `cliCommand`.
 *
 * **Conversation seeding is implemented via direct SQLite injection** into
 * the Hermes state DB at `/opt/data/state.db` (post-hatch, while the
 * gateway is running). The previous version of this adapter shelled out
 * to a fake `hermes conversations new --content-file <path>` command;
 * real Hermes has no non-interactive history-import path — `hermes
 * sessions` is read-only (list / browse / export / delete / prune /
 * stats / rename), the gateway is stateless, and `hermes -r <id>`
 * resumes interactively. So `runSetupCommand({ type:
 * "seed-conversation", ... })` opens `state.db` with Python's stdlib
 * sqlite3 via `docker exec -i ... python3 -` and writes one `sessions`
 * row + N `messages` rows in a single BEGIN IMMEDIATE transaction. The
 * FTS5 indexes are auto-populated by upstream triggers, so search
 * inside Hermes keeps working over seeded history. After seeding,
 * `conversationKey` is updated to the new session id so subsequent
 * `send` / `events` calls target it.
 *
 * @see ./hermes-seed.ts  Seed helper + schema notes.
 */

/**
 * Official Hermes Agent image on Docker Hub, pinned to a date-versioned
 * tag for reproducibility. NousResearch publishes:
 *   - `:latest` and `:main` — moving tags
 *   - `:vYYYY.M.D` — pinned date-versioned releases (digest-stable)
 *   - `:sha-<gitsha>` — per-commit CI builds
 * We pin to a `:vYYYY.M.D` tag until the evals suite is in a steady state
 * so eval reruns are reproducible. Bump intentionally, not by accident.
 */
export const DEFAULT_HERMES_IMAGE = "nousresearch/hermes-agent:v2026.5.16";
/** Default in-container CLI name. The binary at
 * `/opt/hermes/.venv/bin/hermes` is not on the `docker exec` PATH by
 * default — see `EXEC_PATH` below. */
export const DEFAULT_HERMES_CLI = "hermes";
/** Args passed after the image to put the container in long-lived daemon
 * mode. Per Hermes docs, `gateway run` is the documented entrypoint for
 * detached operation. */
export const DEFAULT_HERMES_DAEMON_ARGS = ["gateway", "run"] as const;
/** PATH set on every `docker exec` so the bare `hermes` binary resolves.
 * The Hermes Docker docs explicitly direct exec users to
 * `/opt/hermes/.venv/bin/hermes`; prepending that dir keeps user-written
 * setup commands like `hermes plugins install ...` working without forcing
 * authors to hardcode the absolute path. */
export const EXEC_PATH =
  "/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * LLM provider env vars forwarded from the eval process env into the Hermes
 * container via `-e <NAME>` (docker reads the value from its own env, which
 * inherits from the eval process via NodeCommandRunner's env merge).
 *
 * Limited to model providers whose hosts are on `DEFAULT_MODEL_ALLOW_HOSTS`
 * in the egress jail — egress allowlisting a provider without forwarding
 * its API key would just produce a noisy 401.
 */
export const HERMES_PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
] as const;

export function selectProviderEnvFlags(
  env: Record<string, string | undefined>,
  names: ReadonlyArray<string> = HERMES_PROVIDER_ENV_VARS,
): string[] {
  const flags: string[] = [];
  for (const name of names) {
    if (env[name]) flags.push("-e", name);
  }
  return flags;
}

export interface HermesAgentOptions {
  profile: Profile;
  testId: string;
  runId?: string;
  runner?: CommandRunner;
  /** Docker image to run the Hermes agent from. */
  dockerImage?: string;
  /** Hermes CLI command name inside the container. */
  cliCommand?: string;
  /** Args passed after the image to start the container in daemon mode.
   * Defaults to `["gateway", "run"]` per Hermes Docker docs. */
  daemonArgs?: ReadonlyArray<string>;
  /** Env names to forward into the container via `-e <NAME>`. Defaults to
   * the LLM-provider keys this adapter supports out of the box. */
  providerEnvNames?: ReadonlyArray<string>;
  /** Source map for resolving provider env values. Defaults to
   * `process.env`. Exposed for tests. */
  processEnv?: Record<string, string | undefined>;
}

function setupCommands(profile: Profile): string[] {
  const setup = profile.manifest.setup;
  if (!setup) return [];
  return Array.isArray(setup) ? setup : [setup];
}

/**
 * Wrap a multi-token command into the canonical `sh -c <script>` form.
 *
 * We deliberately use `-c` and NOT `-lc` (login shell). A login shell
 * sources `/etc/profile`, which on the Debian-based Hermes image
 * **overwrites** `PATH` to the system default — clobbering the
 * `--env PATH=${EXEC_PATH}` we set on `docker exec` to put
 * `/opt/hermes/.venv/bin` (where the `hermes` binary lives) on PATH.
 * Without this, every shell-wrapped command that calls bare `hermes`
 * fails with `sh: N: hermes: not found`.
 */
function shellWords(command: string): string[] {
  return ["sh", "-c", command];
}

/**
 * Transcript event type the adapter synthesizes from a single-shot
 * `hermes -z` invocation. `message_chunk` is the cross-species
 * incremental-text event the runner reads as assistant transcript via
 * `assistantContent` (`message.text ?? message.chunk`).
 *
 * Exported so the runner/tests can reference the canonical event shape
 * Hermes turns produce.
 */
export const HERMES_TRANSCRIPT_EVENT_TYPE = "message_chunk";

/**
 * Build the single transcript event for a completed `hermes -z` turn. A
 * one-shot prints only the final assistant text, so a turn maps to exactly
 * one `message_chunk` carrying that text. Always produced (even for an
 * empty answer) so the runner sees a non-empty event window and doesn't
 * mistake a quiet turn for a dead event pipeline.
 *
 * Exported for unit tests.
 */
export function synthesizeHermesTurnEvent(oneshotStdout: string): AgentEvent {
  return {
    message: {
      type: HERMES_TRANSCRIPT_EVENT_TYPE,
      chunk: oneshotStdout.replace(/\s+$/, ""),
    },
  };
}

/**
 * Single-consumer async queue bridging the request/response `send` to the
 * streaming `events()` contract the runner expects. `send` runs one
 * `hermes -z` to completion and `push`es the synthesized turn event; the
 * `AgentEventCollector` draining `events()` pulls one event at a time and
 * stops on its own quiet-window timeout, so the queue never needs to signal
 * "done" between turns — it only `close`s at shutdown to release a parked
 * consumer.
 *
 * The runner guarantees a single outstanding `next()` at a time (it caches
 * the pending promise), so one waiter slot suffices.
 */
class HermesEventQueue {
  private readonly buffered: AgentEvent[] = [];
  private waiting?: (result: IteratorResult<AgentEvent>) => void;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.buffered.push(event);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  iterable(): AsyncIterable<AgentEvent> {
    const next = (): Promise<IteratorResult<AgentEvent>> => {
      if (this.buffered.length > 0) {
        return Promise.resolve({ value: this.buffered.shift()!, done: false });
      }
      if (this.closed) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise((resolve) => {
        this.waiting = resolve;
      });
    };
    return { [Symbol.asyncIterator]: () => ({ next }) };
  }
}

function hermesContainerName(runId: string): string {
  return `${runId}-hermes`;
}

export class HermesAgent implements BaseAgent {
  readonly id: string;
  conversationKey: string;

  private readonly profile: Profile;
  private readonly runner: CommandRunner;
  private readonly cliCommand: string;
  private readonly dockerImage: string;
  private readonly daemonArgs: ReadonlyArray<string>;
  private readonly providerEnvFlags: string[];
  private readonly testId: string;
  private readonly containerName: string;
  private eventSink?: HermesEventQueue;
  private jail?: DockerEgressJail;
  private hatched = false;
  private stopped = false;

  constructor(opts: HermesAgentOptions) {
    this.profile = opts.profile;
    this.testId = opts.testId;
    this.runner = opts.runner ?? new NodeCommandRunner();
    this.cliCommand = opts.cliCommand ?? DEFAULT_HERMES_CLI;
    this.dockerImage = opts.dockerImage ?? DEFAULT_HERMES_IMAGE;
    this.daemonArgs = opts.daemonArgs ?? DEFAULT_HERMES_DAEMON_ARGS;
    this.providerEnvFlags = selectProviderEnvFlags(
      opts.processEnv ?? process.env,
      opts.providerEnvNames,
    );
    this.id =
      opts.runId ?? `eval-${opts.profile.id}-${opts.testId}-${Date.now()}`;
    this.conversationKey = `evals:${opts.testId}:${this.id}`;
    this.containerName = hermesContainerName(this.id);
  }

  async hatch(): Promise<void> {
    if (this.hatched) return;
    if (this.profile.manifest.species !== "hermes") {
      throw new Error(
        `HermesAgent can only run species=hermes profiles (received ${this.profile.manifest.species})`,
      );
    }

    let containerStarted = false;
    try {
      // Detached `docker run` so the Hermes gateway stays up across
      // send/events. The container idles waiting for CLI interactions;
      // outbound model traffic only happens once the egress jail is in
      // place because the gateway shouldn't reach out before it receives
      // its first message.
      await this.runner
        .run("docker", ["rm", "-f", this.containerName])
        .catch(() => undefined);
      const create = await this.runner.run(
        "docker",
        [
          "run",
          "-d",
          "--name",
          this.containerName,
          "--label",
          "evals.vellum.ai/species=hermes",
          ...this.providerEnvFlags,
          this.dockerImage,
          ...this.daemonArgs,
        ],
        {
          logPath: join(runArtifacts(this.id).runDir, "subprocess-hatch.log"),
          logStep: "hatch",
        },
      );
      assertSuccess(create, `start Hermes container for ${this.profile.id}`);
      containerStarted = true;

      this.jail = await applyDockerEgressJail(this.runner, {
        containerName: this.containerName,
        recordingDir: runArtifacts(this.id).runDir,
      });

      for (const [idx, command] of setupCommands(this.profile).entries()) {
        const setup = await this.runner.run(
          "docker",
          [
            "exec",
            "--env",
            `PATH=${EXEC_PATH}`,
            this.containerName,
            ...shellWords(command),
          ],
          {
            logPath: join(
              runArtifacts(this.id).runDir,
              `subprocess-setup-${idx + 1}.log`,
            ),
            logStep: `setup-${idx + 1}`,
          },
        );
        assertSuccess(setup, `setup command for profile ${this.profile.id}`);
      }

      this.hatched = true;
    } catch (err) {
      await this.jail?.stop().catch(() => undefined);
      if (containerStarted) {
        await this.runner
          .run("docker", ["rm", "-f", this.containerName])
          .catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Run one user turn as a single-shot `hermes -z "<prompt>"` and push the
   * synthesized transcript event onto the active `events()` sink.
   *
   * The one-shot runs the full agentic loop to completion and prints only
   * the final assistant text to stdout, so unlike a streaming `send` this
   * call blocks for the whole turn and the response is fully known when it
   * resolves. We run as `--user hermes` (the gateway's unprivileged user)
   * so the memory files the turn writes under `/opt/data/memories/` stay
   * gateway-owned — a root-written memory file would block subsequent
   * hermes-user turns from updating it, the same ownership trap the seed
   * step guards against.
   */
  async send(message: AgentMessage): Promise<void> {
    this.assertHatched();
    const result = await this.runner.run(
      "docker",
      [
        "exec",
        "--user",
        "hermes",
        "--env",
        `PATH=${EXEC_PATH}`,
        this.containerName,
        this.cliCommand,
        "-z",
        message.content,
      ],
      {
        logPath: join(runArtifacts(this.id).runDir, "subprocess-send.log"),
        logStep: "send",
      },
    );
    assertSuccess(result, `send message to ${this.id}`);
    (this.eventSink ??= new HermesEventQueue()).push(
      synthesizeHermesTurnEvent(result.stdout ?? ""),
    );
  }

  async runSetupCommand(command: TestSetupCommand): Promise<void> {
    this.assertHatched();
    switch (command.type) {
      case "seed-conversation": {
        // Direct `state.db` injection — no LLM round-trip, no
        // dependence on a fake import-CLI. Each adapter instance gets
        // exactly one seeded session per run, so we mint a stable id
        // from the testId + runId and route subsequent `send`/`events`
        // through it via `--conversation-key`.
        const sessionId = generateHermesEvalSessionId(this.testId, this.id);
        await seedHermesSession({
          runner: this.runner,
          containerName: this.containerName,
          sessionId,
          messages: command.messages,
          testLabel: this.testId,
        });
        this.conversationKey = sessionId;
        return;
      }
    }
  }

  /**
   * Subscribe to the assistant transcript for the turns that follow.
   *
   * There is no live Hermes event subprocess to drain — a turn's events are
   * synthesized in `send` from the one-shot's stdout. This returns an async
   * iterable backed by a fresh queue and makes it the active sink, so each
   * subsequent `send` pushes its turn event here. Re-subscribing (e.g. a new
   * `AgentEventCollector` per turn) rotates to a new queue; the runner drains
   * one queue at a time and stops each window on its own quiet timeout.
   */
  events(): AsyncIterable<AgentEvent> {
    this.assertHatched();
    const sink = new HermesEventQueue();
    this.eventSink = sink;
    return sink.iterable();
  }

  async readUsageRecords(): Promise<Array<Record<string, unknown>>> {
    return this.jail?.readUsageRecords() ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventSink?.close();
    await this.jail?.stop().catch(() => undefined);
    if (this.hatched) {
      await this.runner
        .run("docker", ["rm", "-f", this.containerName])
        .catch(() => undefined);
    }
  }

  private assertHatched(): void {
    if (!this.hatched) {
      throw new Error(`Agent ${this.id} has not been hatched`);
    }
  }
}

export function createHermesAgent(
  input: AgentHatchInput,
  opts: Omit<HermesAgentOptions, keyof AgentHatchInput> = {},
): HermesAgent {
  return new HermesAgent({ ...input, ...opts });
}

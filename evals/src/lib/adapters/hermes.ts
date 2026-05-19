import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../adapter";
import type { Profile } from "../profile";
import type { TestSetupCommand } from "../setup-command";
import {
  applyDockerEgressJail,
  type DockerEgressJail,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
  type SpawnedProcess,
} from "../runtime/command-runner";
import { parseNdjson } from "../runtime/ndjson";
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
 *   - `docker exec --env PATH=...` for setup, send, events, and seed-
 *     conversation actions. The Hermes binary lives at
 *     `/opt/hermes/.venv/bin/hermes`; the official docs note it's NOT on
 *     PATH for `docker exec` sessions, so we set PATH explicitly.
 *
 * The in-container CLI surface this adapter assumes for `message` and
 * `events` (`hermes message --conversation-key`, `hermes events --json`)
 * mirrors Vellum's `assistant` CLI shape so the evals harness contract
 * stays uniform across species. The exact Hermes subcommand names may
 * differ from what this adapter spells; the docker image, the daemon
 * command, and the in-container CLI command are constructor-overrideable
 * via `dockerImage`, `daemonArgs`, and `cliCommand` so the call surface
 * can be adjusted (or a thin shim CLI dropped into the image) without
 * rewriting the adapter.
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
 *
 * Treat the per-subcommand call surface for `message` and `events` as a
 * structural scaffold against an unverified upstream CLI until we've run
 * against a real Hermes build end-to-end. The container-lifecycle bits
 * (image, daemon command, env forwarding, PATH) are verified against the
 * official Hermes Docker docs.
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

/** Container name suffix differentiates Hermes from Vellum runs side-by-side. */
/**
 * The set of `hermes events --json` event types whose `text` or `chunk`
 * field carries assistant transcript content. Hermes streams a slightly
 * different taxonomy than Vellum — `message_chunk` is the cross-species
 * incremental-text event; `assistant_text_delta` is also accepted in
 * case a Hermes build adopts that naming. Everything else (user-message
 * echoes, tool events, thinking, errors, status) is preserved on the
 * stream but stripped of its stringy payload so it can't be misread as
 * transcript text.
 */
const HERMES_ASSISTANT_TRANSCRIPT_EVENT_TYPES = new Set([
  "message_chunk",
  "assistant_text_delta",
]);

/**
 * Wrap a raw `parseNdjson<AgentEvent>` stream from `hermes events --json`
 * with a normalization step that clears `text` and `chunk` on events
 * that aren't assistant transcript. Mirror of
 * `normalizeVellumEventStream` — same shape, species-specific allowlist.
 *
 * Exported for unit tests.
 */
export async function* normalizeHermesEventStream(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  for await (const event of source) {
    const type = event.message?.type;
    if (
      typeof type === "string" &&
      HERMES_ASSISTANT_TRANSCRIPT_EVENT_TYPES.has(type)
    ) {
      yield event;
      continue;
    }
    yield {
      ...event,
      message: {
        ...event.message,
        text: undefined,
        chunk: undefined,
      },
    };
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
  private eventsProcess?: SpawnedProcess;
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
      const create = await this.runner.run("docker", [
        "run",
        "-d",
        "--name",
        this.containerName,
        "--label",
        "evals.vellum.ai/species=hermes",
        ...this.providerEnvFlags,
        this.dockerImage,
        ...this.daemonArgs,
      ]);
      assertSuccess(create, `start Hermes container for ${this.profile.id}`);
      containerStarted = true;

      this.jail = await applyDockerEgressJail(this.runner, {
        containerName: this.containerName,
      });

      for (const command of setupCommands(this.profile)) {
        const setup = await this.runner.run("docker", [
          "exec",
          "--env",
          `PATH=${EXEC_PATH}`,
          this.containerName,
          ...shellWords(command),
        ]);
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

  async send(message: AgentMessage): Promise<void> {
    this.assertHatched();
    const result = await this.runner.run("docker", [
      "exec",
      "--env",
      `PATH=${EXEC_PATH}`,
      this.containerName,
      this.cliCommand,
      "message",
      "--conversation-key",
      this.conversationKey,
      message.content,
    ]);
    assertSuccess(result, `send message to ${this.id}`);
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

  events(): AsyncIterable<AgentEvent> {
    this.assertHatched();
    this.eventsProcess ??= this.runner.spawn("docker", [
      "exec",
      "--env",
      `PATH=${EXEC_PATH}`,
      this.containerName,
      this.cliCommand,
      "events",
      "--conversation-key",
      this.conversationKey,
      "--json",
    ]);
    // Normalize the species-specific event stream at the adapter
    // boundary so the runner can treat `event.message.text` /
    // `event.message.chunk` as "assistant transcript text, or
    // undefined" without knowing the Hermes daemon's event taxonomy.
    return normalizeHermesEventStream(
      parseNdjson<AgentEvent>(this.eventsProcess.stdout),
    );
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsProcess?.kill();
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

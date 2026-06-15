import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../adapter";
import type { Profile } from "../profile";
import type {
  SeededConversationMessage,
  TestSetupCommand,
} from "../setup-command";
import { runArtifacts } from "../metrics";
import {
  applyDockerEgressJail,
  installRecordingCa,
  type DockerEgressJail,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
} from "../runtime/command-runner";
import {
  generateHermesEvalSessionId,
  HERMES_RUNTIME_USER,
  seedHermesSession,
} from "./hermes-seed";
import { assertSafeWorkspacePath } from "./workspace-path";

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
 *     model-provider allowlist Vellum runs against, keeping cross-species
 *     cost comparisons honest. The jail owns the network namespace and is
 *     created first; Hermes is then born into it via
 *     `--network container:<jail>`, so its gateway's first outbound TLS is
 *     already behind the recording proxy and there is no pre-jail window
 *     for an unrecorded connection to escape. The native Anthropic SDK
 *     Hermes would otherwise install lazily from PyPI is baked into a
 *     derived image at build time (see `hermes-image/Dockerfile`), so the
 *     jailed runtime never needs to reach PyPI.
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
 * **Within-conversation continuity is replayed into each prompt.** Every
 * `hermes -z` invocation is a fresh, stateless session: it ignores
 * `--resume`/`--continue` and forks a new session that loads none of the
 * prior turns. To present one coherent conversation across a test's turns,
 * the adapter accumulates the turns it has exchanged and prepends them to
 * each `-z` prompt (see `buildHermesTurnPrompt`), so turn N sees turns
 * 1..N-1. This is the adapter normalizing Hermes's one-shot model onto the
 * shared multi-turn `send`/`events` contract; it does not depend on any
 * Hermes session id, which the adapter therefore never tracks.
 *
 * Hermes's memory subsystem (files under `/opt/data/memories/`, auto-loaded
 * each shot) is a separate, longer-horizon channel for cross-session recall,
 * not the within-conversation transcript.
 *
 * The docker image, the daemon command, and the in-container CLI command
 * are constructor-overrideable via `dockerImage`, `daemonArgs`, and
 * `cliCommand`.
 *
 * **Conversation seeding is implemented via direct SQLite injection** into
 * the Hermes state DB at `/opt/data/state.db` (post-hatch, while the
 * gateway is running). Seeding models a *separate prior session* (e.g. the
 * timeline-recall memory test), distinct from the live conversation the
 * adapter replays per turn. Real Hermes has no non-interactive
 * history-import path — `hermes sessions` is read-only (list / browse /
 * export / delete / prune / stats / rename), the gateway is stateless, and
 * `hermes -r <id>` resumes interactively. So `runSetupCommand({ type:
 * "seed-conversation", ... })` opens `state.db` with Python's stdlib
 * sqlite3 via `docker exec -i ... python3 -` and writes one `sessions`
 * row + N `messages` rows in a single BEGIN IMMEDIATE transaction. The
 * FTS5 indexes are auto-populated by upstream triggers, so search inside
 * Hermes keeps working over seeded history. (Known limitation: DB-injected
 * seed rows are not auto-indexed into memory, so a seeded prior conversation
 * is recalled only if the agent autonomously searches history.)
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
/**
 * Tag for the locally-built image derived from {@link DEFAULT_HERMES_IMAGE}.
 * The derived image bakes Hermes's lazy-installed provider SDKs (see
 * `hermes-image/Dockerfile`) so a container born inside the fail-closed
 * egress jail is dependency-complete and never reaches PyPI at request
 * time. Built on hatch from the base tag; content-cached by Docker.
 */
export const DERIVED_HERMES_IMAGE = "vellum-evals-hermes:local";

function adapterDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Directory holding the derived Hermes image's Dockerfile + build context. */
function hermesImageDockerfileDir(): string {
  return resolve(adapterDir(), "hermes-image");
}
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
 * Working directory every `hermes -z` turn runs in, and the root that
 * `stage-workspace-file` payloads land under. Hermes's `terminal`/`file`
 * tools resolve relative paths against the process cwd (`terminal.cwd`
 * defaults to `.`, the launch directory — see
 * https://hermes-agent.nousresearch.com/docs), so pinning the exec
 * `--workdir` here and staging files into the same directory lets a test
 * reference an uploaded file by bare name. Mirrors the Vellum adapter's
 * `/workspace` contract so one SPEC discovery hint works across species.
 */
export const HERMES_WORKSPACE_DIR = "/workspace";

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

/**
 * System CA bundle inside the Debian-based Hermes container. The egress
 * jail copies the mitmproxy recording CA into
 * `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`,
 * which regenerates this file to contain the public CA set **plus** the
 * mitmproxy CA.
 */
export const HERMES_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Env flags pointing Hermes's Python TLS stack at the system CA bundle.
 *
 * Hermes is Python: the Anthropic/OpenAI SDKs use httpx, whose default
 * verify context loads **certifi's** bundle and ignores the system trust
 * store that the egress jail updates via `update-ca-certificates`. Without
 * this, every model call fails the mitmproxy TLS handshake and Hermes
 * retries until it times out (surfacing as "API call failed after N
 * retries: Request timed out"). httpx honors `SSL_CERT_FILE`, so pointing
 * it at the jail-augmented system bundle restores trust for both public
 * hosts and the recording proxy; `SSL_CERT_DIR` covers OpenSSL-based
 * tooling for the same reason.
 *
 * Set as `-e NAME=VALUE` on the daemon `docker run`. Each `hermes -z` turn
 * runs via `docker exec`, which inherits the container's run-time env, and
 * the bundle is read when the SSL context is built at request time — after
 * the jail has installed the CA.
 */
export const HERMES_CA_TRUST_ENV_FLAGS = [
  "-e",
  `SSL_CERT_FILE=${HERMES_SYSTEM_CA_BUNDLE}`,
  "-e",
  "SSL_CERT_DIR=/etc/ssl/certs",
] as const;

/**
 * Env var that disables Hermes's runtime "lazy dependency" installs
 * (`/opt/hermes/tools/lazy_deps.py`). Hermes ships optional backends (web
 * search, extra providers, messaging platforms) without their Python deps
 * and `uv pip install`s them in-venv the first time a feature is used.
 *
 * That is fatal under the egress jail. The jail is fail-closed — iptables
 * defaults to DROP and only the model + `platform.vellum.ai` hosts are
 * allowlisted — so a runtime install's connections to PyPI
 * (`files.pythonhosted.org`/`www.python.org`) and GitHub are silently
 * dropped and hang on dead TCP for minutes. The turn that triggered the
 * install hangs with them and eventually fails its retry budget,
 * surfacing as "API call failed after N retries: Request timed out".
 *
 * Set on the daemon run-time env so every jailed `docker exec` turn
 * inherits it: a lazy install then fails fast as `FeatureUnavailable`
 * instead of hanging, so an unmet optional dep degrades gracefully rather
 * than wedging the whole run. Provider SDKs the run genuinely needs are
 * baked into the derived image at build time (see `hermes-image/Dockerfile`),
 * so this lock never blocks a provider Hermes actually uses.
 */
export const HERMES_DISABLE_LAZY_INSTALLS_ENV_FLAGS = [
  "-e",
  "HERMES_DISABLE_LAZY_INSTALLS=1",
] as const;

export interface HermesInferenceSelection {
  provider: string;
  model: string;
}

/**
 * Inference provider + model to pin per forwarded provider key.
 *
 * Hermes's provider auto-resolution (`hermes_cli/auth.py::resolve_provider`)
 * does **not** key off `ANTHROPIC_API_KEY`. With only that key present it
 * falls through its priority list to the `"openrouter"` fallback and tries
 * to reach `openrouter.ai` (plus a `models.dev` catalog probe) on every
 * turn. The egress jail allowlists only the native provider hosts in
 * `DEFAULT_MODEL_ALLOW_HOSTS` (api.anthropic.com / api.openai.com /
 * generativelanguage.googleapis.com), so the Cloudflare-fronted openrouter
 * probe is dropped and the turn hangs on dead TCP until it exhausts its
 * retry budget — surfacing as "API call failed after N retries: Request
 * timed out".
 *
 * Pinning the provider to the forwarded key's native backend keeps every
 * call on an allowlisted host. Hermes requires a model alongside an explicit
 * provider, so we pin one too; the values are the current flagship for each
 * provider, matching the model the stock Vellum daemon uses, so vellum-default
 * and hermes-default compare on the same model.
 *
 * Only keys with a native API-key backend in the pinned image are mapped.
 * `nousresearch/hermes-agent`'s `PROVIDER_REGISTRY` registers `anthropic`
 * (reads `ANTHROPIC_API_KEY`) and `gemini` (reads `GOOGLE_API_KEY` /
 * `GEMINI_API_KEY`), but has **no** plain `openai` provider — its only
 * OpenAI backend is `openai-codex`, an OAuth/ChatGPT-subscription provider
 * that takes no API key. So a forwarded `OPENAI_API_KEY` has nothing to pin
 * to; pinning `HERMES_INFERENCE_PROVIDER=openai` would be rejected as an
 * unknown provider. We omit it and let Hermes resolve normally.
 */
export const HERMES_PROVIDER_INFERENCE: Readonly<
  Record<string, HermesInferenceSelection>
> = {
  ANTHROPIC_API_KEY: { provider: "anthropic", model: "claude-sonnet-4-6" },
  GOOGLE_API_KEY: { provider: "gemini", model: "gemini-2.5-pro" },
  GEMINI_API_KEY: { provider: "gemini", model: "gemini-2.5-pro" },
};

/**
 * Resolve which provider + model to pin from the forwarded provider keys,
 * returning the first match in `names` priority order (mirroring
 * `selectProviderEnvFlags`). Returns `undefined` when no recognized key is
 * set — Hermes then keeps its own configured defaults.
 */
export function selectInferenceSelection(
  env: Record<string, string | undefined>,
  names: ReadonlyArray<string> = HERMES_PROVIDER_ENV_VARS,
): HermesInferenceSelection | undefined {
  for (const name of names) {
    const selection = HERMES_PROVIDER_INFERENCE[name];
    if (selection && env[name]) return selection;
  }
  return undefined;
}

/**
 * `-e` flags pinning Hermes's inference provider + model on the daemon
 * `docker run` (read by every `hermes -z` turn, which inherits the
 * container env). Both must be set together — Hermes rejects a provider
 * override without an accompanying model.
 */
export function inferenceEnvFlags(
  selection: HermesInferenceSelection | undefined,
): string[] {
  if (!selection) return [];
  return [
    "-e",
    `HERMES_INFERENCE_PROVIDER=${selection.provider}`,
    "-e",
    `HERMES_INFERENCE_MODEL=${selection.model}`,
  ];
}

export interface HermesAgentOptions {
  profile: Profile;
  testId: string;
  runId?: string;
  runner?: CommandRunner;
  /** Base Hermes image the derived (provider-SDK-baked) image is built from. */
  dockerImage?: string;
  /** Tag for the locally-built derived image the container runs from. */
  derivedImage?: string;
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
 * Render the `hermes -z` prompt for a turn, threading prior turns through.
 *
 * A one-shot loads none of the conversation, so the only way to make turn N
 * aware of turns 1..N-1 is to put them in the prompt. The first turn (no
 * prior turns) sends the raw message so a single-turn test reads naturally;
 * later turns get the transcript as context followed by the new message and
 * an instruction to reply only to it.
 *
 * Exported for unit tests.
 */
export function buildHermesTurnPrompt(
  priorTurns: ReadonlyArray<SeededConversationMessage>,
  userMessage: string,
): string {
  if (priorTurns.length === 0) return userMessage;
  const transcript = priorTurns
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`,
    )
    .join("\n");
  return [
    "You are continuing an ongoing conversation with the user.",
    "Conversation so far:",
    "",
    transcript,
    "",
    "The user's new message:",
    userMessage,
    "",
    "Reply to the user's new message, using the conversation above as context. Respond only with your reply — do not prefix it with a role label or restate the transcript.",
  ].join("\n");
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
  private readonly baseImage: string;
  private readonly derivedImage: string;
  private readonly daemonArgs: ReadonlyArray<string>;
  private readonly providerEnvFlags: string[];
  private readonly inferenceSelection: HermesInferenceSelection | undefined;
  private readonly testId: string;
  private readonly containerName: string;
  private eventSink?: HermesEventQueue;
  private jail?: DockerEgressJail;
  private hatched = false;
  private stopped = false;
  /** Live conversation turns, replayed into each one-shot prompt for continuity. */
  private readonly liveTurns: SeededConversationMessage[] = [];

  constructor(opts: HermesAgentOptions) {
    this.profile = opts.profile;
    this.testId = opts.testId;
    this.runner = opts.runner ?? new NodeCommandRunner();
    this.cliCommand = opts.cliCommand ?? DEFAULT_HERMES_CLI;
    this.baseImage = opts.dockerImage ?? DEFAULT_HERMES_IMAGE;
    this.derivedImage = opts.derivedImage ?? DERIVED_HERMES_IMAGE;
    this.daemonArgs = opts.daemonArgs ?? DEFAULT_HERMES_DAEMON_ARGS;
    this.providerEnvFlags = selectProviderEnvFlags(
      opts.processEnv ?? process.env,
      opts.providerEnvNames,
    );
    this.inferenceSelection = selectInferenceSelection(
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
      // Bake the derived image first. The build still has open egress, so
      // Hermes's lazy provider SDKs resolve into the image here rather than
      // hitting PyPI from inside the fail-closed jail at request time.
      const build = await this.runner.run(
        "docker",
        [
          "build",
          "-t",
          this.derivedImage,
          "--build-arg",
          `HERMES_BASE=${this.baseImage}`,
          hermesImageDockerfileDir(),
        ],
        {
          logPath: join(
            runArtifacts(this.id).runDir,
            "subprocess-build-image.log",
          ),
          logStep: "build-image",
        },
      );
      assertSuccess(build, `build derived Hermes image ${this.derivedImage}`);

      // The recording jail owns a fresh network namespace and is created
      // first, with its iptables allowlist + NAT REDIRECT and the
      // interception CA all in place before any tenant exists. Hermes is
      // then born into that namespace (`--network container:<jail>`), so
      // its gateway's very first outbound TLS is already behind the proxy
      // — there is no pre-jail window for an unrecorded connection to
      // escape. Because the jail owns the namespace, teardown removes the
      // Hermes container before `jail.stop()` (the owner must outlive its
      // tenants — Docker refuses to remove a container whose netns another
      // still shares).
      this.jail = await applyDockerEgressJail(this.runner, {
        runId: this.id,
        recordingDir: runArtifacts(this.id).runDir,
      });

      // Detached `docker run` so the Hermes gateway stays up across
      // send/events. The container idles waiting for CLI interactions; the
      // gateway opens no outbound model TLS until its first message.
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
          "--network",
          `container:${this.jail.netnsContainer}`,
          "--label",
          "evals.vellum.ai/species=hermes",
          ...this.providerEnvFlags,
          ...inferenceEnvFlags(this.inferenceSelection),
          ...HERMES_CA_TRUST_ENV_FLAGS,
          ...HERMES_DISABLE_LAZY_INSTALLS_ENV_FLAGS,
          this.derivedImage,
          ...this.daemonArgs,
        ],
        {
          logPath: join(runArtifacts(this.id).runDir, "subprocess-hatch.log"),
          logStep: "hatch",
        },
      );
      assertSuccess(create, `start Hermes container for ${this.profile.id}`);
      containerStarted = true;

      // Patch the jail's interception CA into Hermes's trust store before
      // its first model TLS. The gateway makes no outbound model call until
      // its first message, so installing it here (before any turn) is in
      // time; without it the intercepted handshake fails closed.
      await installRecordingCa(
        this.runner,
        runArtifacts(this.id).runDir,
        this.containerName,
      );

      await this.ensureWorkspaceDir();

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
      // Owner-mode teardown order: remove the tenant before the namespace
      // owner.
      if (containerStarted) {
        await this.runner
          .run("docker", ["rm", "-f", this.containerName])
          .catch(() => undefined);
      }
      await this.jail?.stop().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Run one user turn as a single-shot `hermes -z "<prompt>"` and push the
   * synthesized transcript event onto the active `events()` sink.
   *
   * The prompt threads prior live turns (see `buildHermesTurnPrompt`) so the
   * stateless one-shot sees the conversation so far; the new user message and
   * the model's answer are then appended to `liveTurns` for the next turn.
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
    const prompt = buildHermesTurnPrompt(this.liveTurns, message.content);
    const result = await this.runner.run(
      "docker",
      [
        "exec",
        "--user",
        HERMES_RUNTIME_USER,
        "--env",
        `PATH=${EXEC_PATH}`,
        "--workdir",
        HERMES_WORKSPACE_DIR,
        this.containerName,
        this.cliCommand,
        "-z",
        prompt,
      ],
      {
        logPath: join(runArtifacts(this.id).runDir, "subprocess-send.log"),
        logStep: "send",
      },
    );
    assertSuccess(result, `send message to ${this.id}`);
    const answer = result.stdout ?? "";
    this.liveTurns.push({ role: "user", content: message.content });
    this.liveTurns.push({ role: "assistant", content: answer });
    (this.eventSink ??= new HermesEventQueue()).push(
      synthesizeHermesTurnEvent(answer),
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
      case "stage-workspace-file": {
        await this.stageWorkspaceFile(command);
        return;
      }
    }
  }

  /**
   * Create the workspace directory turns run in and hand it to the
   * unprivileged gateway user, so `send`'s `--workdir` always resolves and
   * staged files (written as `hermes`) can be created under it. Idempotent.
   */
  private async ensureWorkspaceDir(): Promise<void> {
    const ensure = await this.runner.run(
      "docker",
      [
        "exec",
        "--user",
        "root",
        this.containerName,
        "sh",
        "-c",
        `mkdir -p "${HERMES_WORKSPACE_DIR}" && chown ${HERMES_RUNTIME_USER} "${HERMES_WORKSPACE_DIR}"`,
      ],
      {
        logPath: join(
          runArtifacts(this.id).runDir,
          "subprocess-workspace-dir.log",
        ),
        logStep: "workspace-dir",
      },
    );
    assertSuccess(ensure, `create workspace dir for ${this.id}`);
  }

  /**
   * Stage a file into the workspace so a turn can read it by name. Parents
   * are created first (mirroring the Vellum adapter), then the payload is
   * piped in over stdin via `cp /dev/stdin <path>` — argv-only, so a path
   * needs no shell quoting and the content is never echoed to the run log.
   *
   * Writes as the gateway's unprivileged `hermes` user (the same user `send`
   * runs `hermes -z` as) so the agent's `file`/`terminal` tools can read and
   * rewrite it without a root-owned-file permission wall — the same
   * ownership discipline the seed step follows.
   */
  private async stageWorkspaceFile(input: {
    path: string;
    content: string;
  }): Promise<void> {
    assertSafeWorkspacePath(input.path);
    const containerPath = `${HERMES_WORKSPACE_DIR}/${input.path}`;
    const containerParent = containerPath.slice(
      0,
      containerPath.lastIndexOf("/"),
    );
    const mkdir = await this.runner.run("docker", [
      "exec",
      "--user",
      HERMES_RUNTIME_USER,
      this.containerName,
      "mkdir",
      "-p",
      containerParent,
    ]);
    assertSuccess(
      mkdir,
      `mkdir -p ${containerParent} for ${this.id} workspace file ${input.path}`,
    );
    const write = await this.runner.run(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        HERMES_RUNTIME_USER,
        this.containerName,
        "cp",
        "/dev/stdin",
        containerPath,
      ],
      {
        stdin: input.content,
        logPath: join(
          runArtifacts(this.id).runDir,
          "subprocess-stage-workspace-file.log",
        ),
        logStep: "stage-workspace-file",
      },
    );
    assertSuccess(write, `stage workspace file ${input.path} into ${this.id}`);
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

  /**
   * A Hermes turn is a single-shot `hermes -z` that synthesizes exactly
   * one `message_chunk` event from its stdout once the shot finishes, so
   * that event is itself the turn-completion signal.
   */
  isTurnComplete(event: AgentEvent): boolean {
    return event.message?.type === HERMES_TRANSCRIPT_EVENT_TYPE;
  }

  async readUsageRecords(): Promise<Array<Record<string, unknown>>> {
    return this.jail?.readUsageRecords() ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventSink?.close();
    // Owner-mode teardown order: the jail owns the network namespace Hermes
    // joined, so the tenant is removed before `jail.stop()` (Docker refuses
    // to remove a container whose netns another container still shares).
    if (this.hatched) {
      await this.runner
        .run("docker", ["rm", "-f", this.containerName])
        .catch(() => undefined);
    }
    await this.jail?.stop().catch(() => undefined);
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

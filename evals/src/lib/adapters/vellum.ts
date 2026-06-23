import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
  ConfirmationDecision,
  ResolvedAppPage,
  WorkspaceFileWrite,
} from "../adapter";
import type { Profile } from "../profile";
import type { TestSetupCommand } from "../setup-command";
import { runArtifacts } from "../metrics";
import {
  applyDockerEgressJail,
  findOpenHostPort,
  VELLUM_ALLOW_HOSTS,
  type DockerEgressJail,
  vellumDockerAssistantContainer,
  vellumDockerSiblingContainers,
} from "../egress/docker-jail";
import { reapContainersForRun } from "./docker-reaper";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
  type SpawnedProcess,
} from "../runtime/command-runner";
import { parseNdjson } from "../runtime/ndjson";
import { assertSafeWorkspacePath } from "./workspace-path";
import { inlineAppDist } from "./vellum-app-page";

export interface VellumAgentOptions {
  profile: Profile;
  testId: string;
  runId?: string;
  runner?: CommandRunner;
  cliCommand?: string;
  /**
   * Environment to read provider API keys from before invoking the hatch
   * subprocess. Defaults to `process.env`. Injected for tests so we can
   * assert env forwarding without mutating the host environment.
   */
  processEnv?: NodeJS.ProcessEnv;
}

function setupCommands(profile: Profile): string[] {
  const setup = profile.manifest.setup;
  if (!setup) return [];
  return Array.isArray(setup) ? setup : [setup];
}

/**
 * Feature flags every vellum-species hatch turns on before any setup
 * commands fire.
 *
 * Lives as a hardcoded constant — not a manifest field — because the
 * baseline gated surfaces a vellum assistant ships with are a property
 * of the species, not of an individual profile. A reader of a profile's
 * `manifest.json` doesn't need to opt into `external-plugins` to use
 * `assistant plugins install` in `setup`; that's the species default.
 * If a hypothetical future vellum profile ever needs the flag OFF, the
 * fix is to widen this constant into a (species default) ∪ (manifest
 * override) merge — but YAGNI until that profile exists.
 *
 * Ordered alphabetically by key so that:
 *   - run logs and `subprocess-feature-flag-N.log` filenames are
 *     deterministic across runs;
 *   - tests assert on the recorded call sequence without relying on
 *     object-literal insertion order.
 */
const VELLUM_DEFAULT_FEATURE_FLAGS: ReadonlyArray<readonly [string, boolean]> =
  [["external-plugins", true]] as const;

/**
 * Canonical environment variable names for LLM provider API keys.
 *
 * Mirrors the LLM half of `cli/src/shared/provider-env-vars.ts`. Duplicated
 * here on purpose: this package's adapters are CLI-boundary-oriented and do
 * not import from `cli/src/` internals (see `evals/AGENTS.md`). Drift is
 * unlikely to matter — the Vellum docker StatefulSet spec is what ultimately
 * forwards each of these into the assistant container, and the assistant
 * runtime falls back to `process.env[<NAME>]` when the secure store is empty.
 * If a new LLM provider is added the worst case is that its eval runs need a
 * `keys set` setup step until this list is widened.
 */
const LLM_PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
] as const;

/**
 * Pick LLM provider API keys from the given env and return them as a flat
 * record suitable for `CommandRunner.run({ env })`. Only keys with a
 * non-empty value are included so absent vars don't get propagated as empty
 * strings (which the assistant runtime treats as "configured but invalid").
 */
function selectProviderEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LLM_PROVIDER_ENV_VARS) {
    const value = source[name];
    if (value && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Absolute path to the vellum-assistant repo root, derived from this file's
 * location (`evals/src/lib/adapters/vellum.ts` → repo root via four `..`s).
 * Passed to `vellum hatch --source <path>` so each eval run builds CLI/daemon
 * images from the local source tree.
 */
function repoRootFromAdapter(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

function shellWords(command: string): string[] {
  return ["sh", "-lc", command];
}

/**
 * The set of `vellum events --json` event types whose `text` field carries
 * assistant transcript content. Everything else the daemon emits over SSE
 * (user_message_echo, tool_use_start, tool_input_delta, tool_output_chunk,
 * assistant_thinking_delta, message_complete, error, assistant_usage, …)
 * may also carry stringy fields, but those represent the user's outbound
 * text, tool I/O, internal thinking, status flags, etc. — none of them
 * are assistant-transcript text and none should land in the eval's
 * accumulated transcript.
 *
 * Notably this filter is what stops the `user_message_echo` event (where
 * `msg.text` is the user's own outbound) from being read back as the
 * assistant's first reply — the "vellum echoes the user" symptom from
 * the iter-2 evals run.
 *
 * `message_chunk` is the cross-species transcript event some species
 * emit; the Vellum daemon doesn't emit it today, but if it ever did it
 * should also count as transcript.
 */
const VELLUM_ASSISTANT_TRANSCRIPT_EVENT_TYPES = new Set([
  "assistant_text_delta",
  "message_chunk",
]);

/**
 * Wrap a raw `parseNdjson<AgentEvent>` stream from `vellum events --json`
 * with a normalization step that **clears `text` and `chunk` on events
 * that don't carry assistant transcript text**. The event itself is
 * preserved (artifact logs still show it) — only the stringy fields
 * that downstream consumers read as transcript are zeroed out.
 *
 * Doing this filtering at the adapter boundary means the runner's
 * `assistantContent()` getter stays trivial: `event.message.text ??
 * event.message.chunk`, with no species-specific switch table.
 *
 * Exported for unit tests.
 */
export async function* normalizeVellumEventStream(
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  for await (const event of source) {
    const type = event.message?.type;
    if (
      typeof type === "string" &&
      VELLUM_ASSISTANT_TRANSCRIPT_EVENT_TYPES.has(type)
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

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function seedConversationCommand(containerSeedPath: string): string {
  const quotedSeedPath = shellSingleQuote(containerSeedPath);
  return [
    "set -e",
    `cleanup() { rm -f ${quotedSeedPath}; }`,
    "trap cleanup EXIT",
    `assistant conversations new --content-file ${quotedSeedPath}`,
  ].join("\n");
}

function parseConversationKey(output: string): string | null {
  const match = output.match(/conversation key: ([^\s,]+)/);
  return match?.[1] ?? null;
}

/**
 * Workspace path inside the assistant container. Pinned to
 * `VELLUM_WORKSPACE_DIR` in `cli/src/lib/statefulset.ts`; if that
 * static env value ever moves, this constant moves with it. Adapters
 * deliberately do NOT import from `cli/src/` (see `evals/AGENTS.md`),
 * so duplication here is intentional.
 */
const CONTAINER_WORKSPACE_DIR = "/workspace";

/**
 * Directory inside the assistant container where the app builder writes
 * compiled sandbox apps: `<dirName>/dist/index.html` plus sibling
 * `main.js` / `main.css`. Derived from the daemon's app-store layout
 * (`getAppsDir()` = `<workspace>/data/apps` in `assistant/src/memory/`),
 * pinned here because adapters do NOT import from `assistant/` (see
 * `evals/AGENTS.md`); if the daemon's layout moves, this moves with it.
 */
const CONTAINER_APPS_DIR = `${CONTAINER_WORKSPACE_DIR}/data/apps`;

/**
 * Internal port the gateway reverse-proxy listens on inside the container,
 * pinned to `GATEWAY_INTERNAL_PORT` in `cli/src/lib/environments/paths.ts`.
 * When the egress jail owns the network namespace it — not the assistant —
 * publishes this to the host, and the harness reaches the assistant
 * entirely through it (`vellum message` / `events` / `confirm` target the
 * gateway runtime URL; `exec` uses `docker exec`). Adapters deliberately do
 * NOT import from `cli/src/` (see `evals/AGENTS.md`), so duplication is
 * intentional; if the CLI default moves, this moves with it.
 */
const GATEWAY_CONTAINER_PORT = 7830;

export class VellumAgent implements BaseAgent {
  readonly id: string;
  conversationKey: string;

  private readonly profile: Profile;
  private readonly runner: CommandRunner;
  private readonly cliCommand: string;
  private readonly testId: string;
  private readonly assistantContainerName: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private eventsProcess?: SpawnedProcess;
  private jail?: DockerEgressJail;
  private hatched = false;
  private stopped = false;

  constructor(opts: VellumAgentOptions) {
    this.profile = opts.profile;
    this.testId = opts.testId;
    this.runner = opts.runner ?? new NodeCommandRunner();
    this.cliCommand = opts.cliCommand ?? "vellum";
    this.processEnv = opts.processEnv ?? process.env;
    this.id =
      opts.runId ?? `eval-${opts.profile.id}-${opts.testId}-${Date.now()}`;
    this.conversationKey = `evals:${opts.testId}:${this.id}`;
    this.assistantContainerName = vellumDockerAssistantContainer(this.id);
  }

  async hatch(): Promise<void> {
    if (this.hatched) return;
    if (this.profile.manifest.species !== "vellum") {
      throw new Error(
        `VellumAgent can only run species=vellum profiles (received ${this.profile.manifest.species})`,
      );
    }

    // Catch-path teardown policy:
    //
    // - `captureContainerForensics` is ALWAYS called on failure. It only
    //   reads (`docker inspect`, `docker logs --tail 200`), never
    //   destroys, so running it against a hatch that died at any stage —
    //   including a port-collision failure that never created our
    //   containers — is safe and is exactly the failure mode where
    //   operators most need the forensics.
    //
    // - `vellum retire` is gated on `hatchSucceeded` and runs BEFORE
    //   `jail.stop()`. The jail owns the network namespace the assistant
    //   tenants join, so the tenants must be removed first (Docker refuses
    //   to remove a container whose netns another container still shares).
    //   Retire is destructive (`docker rm -f` + volume teardown), and if
    //   hatch failed with "name already exists" we'd be tearing down
    //   another process's live containers. The `findOpenPort()` in
    //   `hatchDocker` plus the jail publishing a freshly-allocated host
    //   port make that path almost impossible, but defensively we still
    //   only retire what we know we created — the ms-precision + random
    //   suffix on `runId` (see `evals/src/commands/run.ts#timestampSuffix`)
    //   means a successful hatch unambiguously means the resources
    //   under our `instanceName` are ours.
    //
    // - `jail.stop()` is ALWAYS called, LAST. It's a no-op if we never
    //   assigned `this.jail` (i.e. we died before creating the jail), and
    //   it removes the jail container then its owned network.
    let hatchSucceeded = false;
    try {
      // Allocate the host port the gateway will be reachable on before
      // anything starts. The jail owns the network namespace, so it — not
      // the assistant — must publish this port, which means it has to be
      // known before the jail is created. `hatch --gateway-port` then
      // reuses the same value so the lockfile's runtime URL matches what
      // the jail actually published.
      const gatewayPort = await findOpenHostPort();

      // Create the recording egress jail FIRST, as the owner of a fresh
      // network namespace. It installs the iptables allowlist + NAT
      // REDIRECT and generates the interception CA before any assistant
      // process exists, so the daemon is born behind the proxy with no
      // pre-jail window for its first outbound TLS to slip through.
      this.jail = await applyDockerEgressJail(this.runner, {
        runId: this.id,
        recordingDir: runArtifacts(this.id).runDir,
        // Vellum runs the on-device embedder for dense memory recall, so its
        // jail additionally allowlists the embedder's npm/HuggingFace
        // download hosts. Hermes never embeds locally and keeps the
        // model-provider-only default, so cross-species cost stays honest.
        allowHosts: VELLUM_ALLOW_HOSTS,
        publishPorts: [
          { hostPort: gatewayPort, containerPort: GATEWAY_CONTAINER_PORT },
        ],
        // Bind-mount the live repo's `plugins/` into the
        // recording sidecar so the addon's mock-github handler can
        // serve `assistant plugins install` traffic from disk instead
        // of letting it egress to github.com. The runner always runs
        // inside the repo (`repoRootFromAdapter()` drives the hatch
        // `--source` arg below), so the fixtures path is always
        // resolvable here.
        pluginFixturesDir: resolve(repoRootFromAdapter(), "plugins"),
      });

      // Forward LLM provider API keys from the eval process env into the
      // hatch subprocess explicitly. The Vellum docker StatefulSet spec
      // conditionally re-forwards each of these from `vellum hatch`'s env
      // into the assistant container (see `cli/src/lib/statefulset.ts`),
      // and the assistant runtime falls back to `process.env[<NAME>]` when
      // the secure store is empty. Without this, runs would fail with
      // `HTTP 422: No API key configured for anthropic` on the first send.
      //
      // `--netns-container` joins the assistant/gateway/CES into the jail's
      // namespace (born jailed); `--gateway-port` matches the port the jail
      // published; `--assistant-ca-cert` trusts the interception CA from
      // process start so the daemon's first TLS handshake succeeds.
      const hatch = await this.runner.run(
        this.cliCommand,
        [
          "hatch",
          "vellum",
          "--remote",
          "docker",
          "--source",
          repoRootFromAdapter(),
          "--name",
          this.id,
          "--netns-container",
          this.jail.netnsContainer,
          "--gateway-port",
          String(gatewayPort),
          "--assistant-ca-cert",
          this.jail.caCertPath,
        ],
        {
          env: selectProviderEnv(this.processEnv),
          logPath: runArtifacts(this.id).runDir + "/subprocess-hatch.log",
          logStep: "hatch",
        },
      );
      assertSuccess(hatch, `hatch Vellum profile ${this.profile.id}`);
      // Hatch subprocess succeeded → docker resources under our
      // instanceName are unambiguously ours. Only now is `retire` safe
      // in the catch path.
      hatchSucceeded = true;

      // Apply species-default feature flags BEFORE setup commands.
      // Setup commands execute inside the assistant container via
      // `vellum exec`, but flag overrides live on the host gateway —
      // so any setup step that depends on a gated surface (e.g.
      // `assistant plugins install` gated by `external-plugins`) needs
      // the flag flipped first. `vellum flags set --assistant <id>`
      // targets this specific instance without mutating the user's
      // active-assistant pointer.
      for (const [
        idx,
        [key, value],
      ] of VELLUM_DEFAULT_FEATURE_FLAGS.entries()) {
        const flagStep = await this.runner.run(
          this.cliCommand,
          [
            "flags",
            "set",
            key,
            value ? "true" : "false",
            "--assistant",
            this.id,
          ],
          {
            logPath:
              runArtifacts(this.id).runDir +
              `/subprocess-feature-flag-${idx + 1}.log`,
            logStep: `feature-flag-${idx + 1}`,
          },
        );
        assertSuccess(
          flagStep,
          `vellum species default feature flag "${key}=${value}" for profile ${this.profile.id}`,
        );
      }

      for (const [idx, command] of setupCommands(this.profile).entries()) {
        const setup = await this.runner.run(
          this.cliCommand,
          ["exec", this.id, "--", ...shellWords(command)],
          {
            logPath:
              runArtifacts(this.id).runDir + `/subprocess-setup-${idx + 1}.log`,
            logStep: `setup-${idx + 1}`,
          },
        );
        assertSuccess(setup, `setup command for profile ${this.profile.id}`);
      }

      this.hatched = true;
    } catch (err) {
      // Capture container forensics BEFORE any teardown — once
      // containers are removed, `docker inspect` and `docker logs`
      // both return empty. Best-effort: any failure here (docker not
      // installed, container gone, permission error) is silently
      // ignored so we never shadow the original error with a
      // diagnostics-capture error.
      await this.captureContainerForensics().catch(() => undefined);
      if (hatchSucceeded) {
        // Hatch returned 0 but a later step (feature flags, setup
        // commands) threw — we own the tenant containers. Retire them
        // BEFORE stopping the jail: they share the jail's network
        // namespace, so the jail can't be removed while they exist.
        await this.runRetireWithReaperFallback("hatch-catch");
      }
      // Jail teardown is LAST and unconditional: it owns the namespace,
      // so it must outlive the tenants. No-op if we died before creating
      // it. Removes the jail container then its owned network.
      await this.jail?.stop().catch(() => undefined);
      // If hatchSucceeded is false the hatch subprocess itself failed.
      // We deliberately do NOT call `vellum retire` here: another
      // process may legitimately hold an overlapping instance name in
      // an extreme edge case, and we'd rather leak our own dead
      // resources (they can be reaped with `docker container prune`)
      // than risk tearing down a healthy parallel run.
      throw err;
    }
  }

  /**
   * On hatch failure, snapshot the docker state of every sibling
   * container `vellum hatch` provisions (assistant + gateway +
   * credential-executor) so the report-server UI can render what went
   * wrong. Writes two artifacts per container under the run directory:
   *
   *   - `docker-inspect-<service>.json` — raw `docker inspect` output.
   *     Carries State.Status ("created" / "exited" / "dead" / ...),
   *     ExitCode, OOMKilled, Error string, mounts, etc. A tenant that
   *     crash-loops or exits during boot shows up here with its exit
   *     code and error string, which is the most actionable artifact
   *     for diagnosing why the hatch failed.
   *   - `docker-logs-<service>.txt` — last 200 lines of the container's
   *     stdout/stderr (interleaved by docker, no `[STDOUT]` /
   *     `[STDERR]` prefixes since this isn't going through the logPath
   *     tee).
   *
   * All writes are best-effort — failures are swallowed so a missing
   * docker binary or already-gone container never masks the hatch
   * error.
   */
  private async captureContainerForensics(): Promise<void> {
    const artifacts = runArtifacts(this.id);
    const siblings = vellumDockerSiblingContainers(this.id);
    for (const container of siblings) {
      // `service` is the suffix-after-runId; matches the same labels
      // the cleanup helper uses so report URLs stay parseable.
      const service = container.slice(this.id.length + 1); // strip `${runId}-`
      const inspect = await this.runner
        .run("docker", ["inspect", container])
        .catch(() => undefined);
      if (inspect && inspect.exitCode === 0 && inspect.stdout) {
        await writeFile(
          join(artifacts.runDir, `docker-inspect-${service}.json`),
          inspect.stdout,
        ).catch(() => undefined);
      }
      const logs = await this.runner
        .run("docker", ["logs", "--tail", "200", container])
        .catch(() => undefined);
      if (logs) {
        const combined =
          (logs.stdout ?? "") +
          (logs.stderr ? `\n--- stderr ---\n${logs.stderr}` : "");
        if (combined.length > 0) {
          await writeFile(
            join(artifacts.runDir, `docker-logs-${service}.txt`),
            combined,
          ).catch(() => undefined);
        }
      }
    }
  }

  async send(message: AgentMessage): Promise<void> {
    this.assertHatched();
    const result = await this.runner.run(this.cliCommand, [
      "message",
      this.id,
      "--conversation-key",
      this.conversationKey,
      message.content,
    ]);
    assertSuccess(result, `send message to ${this.id}`);
  }

  /**
   * Resolve a pending tool confirmation the agent raised. A hatched
   * assistant runs headless with no interactive approver, so any tool
   * above the auto-approve risk threshold stalls on a pending
   * `confirmation_request` until something answers it. Runners that
   * auto-approve during a turn call this on each such event so the turn
   * can proceed. Routes through the gateway via `vellum confirm`.
   */
  async confirm(input: ConfirmationDecision): Promise<void> {
    this.assertHatched();
    const result = await this.runner.run(this.cliCommand, [
      "confirm",
      this.id,
      "--request-id",
      input.requestId,
      "--decision",
      input.decision,
    ]);
    assertSuccess(result, `confirm ${input.requestId} for ${this.id}`);
  }

  async runSetupCommand(command: TestSetupCommand): Promise<void> {
    switch (command.type) {
      case "seed-conversation": {
        const seedDir = await mkdtemp(join(tmpdir(), "vellum-evals-seed-"));
        const seedFile = join(seedDir, "conversation.json");
        const containerSeedPath = `/tmp/${this.id}-conversation-seed.json`;
        try {
          await writeFile(seedFile, JSON.stringify(command.messages), "utf8");
          const copy = await this.runner.run("docker", [
            "cp",
            seedFile,
            `${this.assistantContainerName}:${containerSeedPath}`,
          ]);
          assertSuccess(copy, `copy seed conversation for ${this.id}`);

          const result = await this.runner.run(this.cliCommand, [
            "exec",
            this.id,
            "--",
            ...shellWords(seedConversationCommand(containerSeedPath)),
          ]);
          assertSuccess(result, `seed conversation for ${this.id}`);
          const conversationKey = parseConversationKey(result.stdout);
          if (!conversationKey) {
            throw new Error(
              `seed conversation for ${this.id} did not return a conversation key`,
            );
          }
          this.conversationKey = conversationKey;
        } finally {
          await rm(seedDir, { recursive: true, force: true });
        }
        break;
      }
      case "stage-workspace-file": {
        await this.writeWorkspaceFile({
          path: command.path,
          content: command.content,
        });
        break;
      }
    }
  }

  /**
   * Stage a file into the assistant container's workspace. Used by the
   * file-on-disk injection contract in `runIngestAsk` — the runner
   * writes the haystack here *before* sending the ingest message that
   * tells the agent where to read it.
   *
   * Flow: write content to a host temp file → `docker cp` into the
   * container at `${CONTAINER_WORKSPACE_DIR}/<path>`. Parent dirs are
   * created in the container first so `docker cp` doesn't fail on a
   * missing intermediate directory.
   *
   * Path safety: workspace-relative only. Absolute paths and `..`
   * segments are rejected up front by `assertSafeWorkspacePath`.
   */
  async writeWorkspaceFile(input: WorkspaceFileWrite): Promise<void> {
    this.assertHatched();
    assertSafeWorkspacePath(input.path);
    const stageDir = await mkdtemp(join(tmpdir(), "vellum-evals-workspace-"));
    const stagePath = join(stageDir, "payload");
    const containerPath = `${CONTAINER_WORKSPACE_DIR}/${input.path}`;
    const containerParent = containerPath.slice(
      0,
      containerPath.lastIndexOf("/"),
    );
    try {
      await writeFile(stagePath, input.content, "utf8");
      // Create the destination parent dir inside the container so
      // `docker cp` doesn't error on intermediate paths that don't
      // exist yet (e.g. `inputs/longmemeval/<id>/`).
      const mkdir = await this.runner.run("docker", [
        "exec",
        this.assistantContainerName,
        "mkdir",
        "-p",
        containerParent,
      ]);
      assertSuccess(
        mkdir,
        `mkdir -p ${containerParent} for ${this.id} workspace file ${input.path}`,
      );
      const copy = await this.runner.run("docker", [
        "cp",
        stagePath,
        `${this.assistantContainerName}:${containerPath}`,
      ]);
      assertSuccess(copy, `docker cp ${input.path} to ${this.id} workspace`);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }

  /**
   * Open a fresh conversation against the same agent. Persistent state
   * (memory layer, workspace files, hatched container) survives — only
   * the chat history resets so the next `send()` cannot see prior
   * turns. Used by `runIngestAsk` to enforce the two-conversation
   * contract: the question turn must not see the ingest transcript,
   * only the memory layer's distillation of it.
   *
   * Invokes `assistant conversations new` (no `--content-file`) inside
   * the container via `vellum exec`. Parses the generated conversation
   * key from stdout and updates `this.conversationKey`.
   *
   * Also kills + clears the cached `events()` subprocess. `events()`
   * memoizes the spawned `vellum events --conversation-key …` process
   * (so repeated calls share one SSE stream), but that process is
   * bound to the conversation key it was *started* with — bumping
   * `this.conversationKey` here without invalidating the cache would
   * leave the next `events()` caller reading the prior conversation's
   * stream. `runIngestAsk` exercises exactly this sequence: subscribe
   * to A → drain → `newConversation()` → subscribe to B → drain.
   * Without the invalidation the B subscription silently re-reads the
   * A stream and the question turn looks like "zero events".
   */
  async newConversation(): Promise<void> {
    this.assertHatched();
    const result = await this.runner.run(this.cliCommand, [
      "exec",
      this.id,
      "--",
      "assistant",
      "conversations",
      "new",
    ]);
    assertSuccess(result, `open new conversation for ${this.id}`);
    const conversationKey = parseConversationKey(result.stdout);
    if (!conversationKey) {
      throw new Error(
        `assistant conversations new for ${this.id} did not return a conversation key (stdout: ${result.stdout})`,
      );
    }
    this.conversationKey = conversationKey;

    // Drop the events-process cache so the next `events()` call
    // respawns against the rotated key. Safe even if `events()` was
    // never called — `?.kill()` and `= undefined` are no-ops.
    this.eventsProcess?.kill();
    this.eventsProcess = undefined;
  }

  events(): AsyncIterable<AgentEvent> {
    this.assertHatched();
    this.eventsProcess ??= this.runner.spawn(this.cliCommand, [
      "events",
      this.id,
      "--conversation-key",
      this.conversationKey,
      "--json",
    ]);
    // Normalize the species-specific event stream at the adapter
    // boundary so the runner can treat `event.message.text` as
    // "assistant transcript text, or undefined" without knowing the
    // Vellum daemon's full SSE event taxonomy.
    return normalizeVellumEventStream(
      parseNdjson<AgentEvent>(this.eventsProcess.stdout),
    );
  }

  /**
   * The Vellum daemon closes every turn with a `message_complete` SSE
   * event — including turns truncated by a response limit — and emits
   * `error` when the turn aborts. Either one means the daemon is done
   * responding to the message.
   */
  isTurnComplete(event: AgentEvent): boolean {
    const type = event.message?.type;
    return type === "message_complete" || type === "error";
  }

  async readUsageRecords(): Promise<Array<Record<string, unknown>>> {
    return this.jail?.readUsageRecords() ?? [];
  }

  /**
   * Resolve the most recently built sandbox app into a single
   * self-contained HTML page the runner can load in a headless browser.
   *
   * The app builder compiles apps to `dist/index.html` plus sibling
   * `main.js` / `main.css` under `${CONTAINER_APPS_DIR}/<dirName>/`. We
   * read those files straight off the container's stdout (no `docker cp`
   * round-trip) and inline the assets so the result renders from
   * `page.setContent(html)` alone — the daemon performs the equivalent
   * inlining when it delivers an app over SSE.
   *
   * Returns `undefined` when the agent built no app this run, so the
   * runner skips the app-interaction phase.
   */
  async resolveAppPage(): Promise<ResolvedAppPage | undefined> {
    this.assertHatched();
    const [distDir] = await this.listAppDistDirs();
    if (distDir === undefined) return undefined;
    const indexHtml = await this.readContainerTextFile(`${distDir}/index.html`);
    if (indexHtml === undefined) return undefined;
    const mainJs = await this.readContainerTextFile(`${distDir}/main.js`);
    const mainCss = await this.readContainerTextFile(`${distDir}/main.css`);
    return { html: inlineAppDist({ indexHtml, mainJs, mainCss }) };
  }

  /**
   * List every compiled app's `dist` directory, newest first by
   * `dist/index.html` mtime. Each returned path is the dist dir (the path
   * up to the `index.html`'s last `/`). The glob is quoted so the shell —
   * not this process — expands it inside the container, and `2>/dev/null`
   * swallows the "no matches" stderr so the command still exits 0 with
   * empty stdout.
   */
  private async listAppDistDirs(): Promise<string[]> {
    const result = await this.runner.run("docker", [
      "exec",
      this.assistantContainerName,
      "sh",
      "-lc",
      `ls -1t ${CONTAINER_APPS_DIR}/*/dist/index.html 2>/dev/null`,
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((indexPath) => indexPath.slice(0, indexPath.lastIndexOf("/")));
  }

  /**
   * Read a UTF-8 text file out of the assistant container via
   * `docker exec cat`, or `undefined` when it doesn't exist. Used for
   * the optional `main.js` / `main.css` assets, so a non-zero exit
   * (missing file) is a normal "asset absent" signal rather than an
   * error — hence the exit-code check instead of `assertSuccess`.
   */
  private async readContainerTextFile(
    containerPath: string,
  ): Promise<string | undefined> {
    const result = await this.runner.run("docker", [
      "exec",
      this.assistantContainerName,
      "cat",
      containerPath,
    ]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsProcess?.kill();
    // Retire the tenant containers BEFORE stopping the jail: they share
    // the jail's network namespace, so Docker refuses to remove the jail
    // while they exist. The jail (namespace owner) is torn down last.
    if (this.hatched) {
      await this.runRetireWithReaperFallback("shutdown");
    }
    await this.jail?.stop().catch(() => undefined);
  }

  /**
   * Runs `vellum retire <id>` and force-reaps any surviving sibling
   * containers as a fallback.
   *
   * Retire failures must be both surfaced and backstopped:
   *
   *  1. **Silent leaks.** A non-zero retire exit (e.g. the daemon died
   *     mid-run, so `assistant-config` lookup throws) leaves the tenant
   *     containers alive. Because they share the egress jail's network
   *     namespace, the leak also blocks `jail.stop()` from removing the
   *     jail container and its network — surviving Docker resources
   *     accumulate across a batch run until manually pruned.
   *  2. **Invisible diagnosis.** Without surfacing, operators see the
   *     leak but have no trail back to the failed retire — the original
   *     error never surfaces anywhere readable.
   *
   * The handling has two layers:
   *
   *  - **Surface**: capture retire's exit code and stderr; emit a
   *    `[retire]` warning to the operator log if it failed. This
   *    flows through the runner subprocess log file so it lands in
   *    the report UI under the failing run.
   *  - **Force reap**: regardless of retire's exit code, call
   *    `reapContainersForRun(runner, id)`. Retire's container-removal
   *    step is `docker rm -f <name>` per sibling — if those succeeded,
   *    our reap is a no-op (containers already gone). If they failed for
   *    whatever reason, our reap removes the tenants so the subsequent
   *    `jail.stop()` can tear the jail's namespace down cleanly.
   *
   * Best-effort: a failure inside the reaper itself (docker missing,
   * daemon down) never throws. The goal is to fail safely, not to
   * introduce a new throw site downstream of an already-failed run.
   */
  private async runRetireWithReaperFallback(
    callSite: "hatch-catch" | "shutdown",
  ): Promise<void> {
    let retireResult: { exitCode: number; stderr: string } | undefined;
    let retireError: unknown;
    try {
      retireResult = await this.runner.run(this.cliCommand, [
        "retire",
        this.id,
        "--yes",
      ]);
    } catch (err) {
      retireError = err;
    }
    if (retireError || (retireResult && retireResult.exitCode !== 0)) {
      const detail =
        retireError instanceof Error
          ? retireError.message
          : retireResult?.stderr?.trim() ||
            `exit code ${retireResult?.exitCode ?? "<unknown>"}`;
      // `console.warn` is the lowest-friction surfacing path — the
      // runner's subprocess log capture aggregates stderr lines into
      // the run dir, so this lands in the report UI's expand-subprocess
      // panel for the failing test alongside the original error.
      console.warn(
        `[retire] vellum retire ${this.id} failed (${callSite}): ${detail}`,
      );
    }
    const reapResult = await reapContainersForRun(this.runner, this.id).catch(
      () => ({ reaped: [] as string[] }),
    );
    if (reapResult.reaped.length > 0) {
      console.warn(
        `[retire] force-reaped surviving container(s) for ${this.id} (${callSite}): ${reapResult.reaped.join(", ")}`,
      );
    }
  }

  private assertHatched(): void {
    if (!this.hatched) {
      throw new Error(`Agent ${this.id} has not been hatched`);
    }
  }
}

export function createVellumAgent(
  input: AgentHatchInput,
  opts: Omit<VellumAgentOptions, keyof AgentHatchInput> = {},
): VellumAgent {
  return new VellumAgent({ ...input, ...opts });
}

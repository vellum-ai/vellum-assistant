import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
  vellumDockerAssistantContainer,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
  type SpawnedProcess,
} from "../runtime/command-runner";
import { parseNdjson } from "../runtime/ndjson";

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

    let hatchStarted = false;
    try {
      // Forward LLM provider API keys from the eval process env into the
      // hatch subprocess explicitly. The Vellum docker StatefulSet spec
      // conditionally re-forwards each of these from `vellum hatch`'s env
      // into the assistant container (see `cli/src/lib/statefulset.ts`),
      // and the assistant runtime falls back to `process.env[<NAME>]` when
      // the secure store is empty. Without this, runs would fail with
      // `HTTP 422: No API key configured for anthropic` on the first send.
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
        ],
        { env: selectProviderEnv(this.processEnv) },
      );
      assertSuccess(hatch, `hatch Vellum profile ${this.profile.id}`);
      hatchStarted = true;

      this.jail = await applyDockerEgressJail(this.runner, {
        containerName: this.assistantContainerName,
        recordingDir: runArtifacts(this.id).runDir,
      });

      for (const command of setupCommands(this.profile)) {
        const setup = await this.runner.run(this.cliCommand, [
          "exec",
          this.id,
          "--",
          ...shellWords(command),
        ]);
        assertSuccess(setup, `setup command for profile ${this.profile.id}`);
      }

      this.hatched = true;
    } catch (err) {
      await this.jail?.stop().catch(() => undefined);
      if (hatchStarted) {
        await this.runner
          .run(this.cliCommand, ["retire", this.id])
          .catch(() => undefined);
      }
      throw err;
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
    }
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

  async readUsageRecords(): Promise<Array<Record<string, unknown>>> {
    return this.jail?.readUsageRecords() ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsProcess?.kill();
    await this.jail?.stop().catch(() => undefined);
    if (this.hatched) {
      await this.runner
        .run(this.cliCommand, ["retire", this.id])
        .catch(() => undefined);
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

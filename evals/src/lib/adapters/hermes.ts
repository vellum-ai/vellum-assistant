import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * Hermes adapter — runs a NousResearch Hermes agent in Docker for eval runs.
 *
 * Hermes is a separate, external assistant species. Unlike Vellum, there is
 * no `vellum hatch hermes` host command and no host-side Hermes CLI that
 * manages container lifecycle for us. The adapter therefore drives Docker
 * directly:
 *
 *   - `docker run -d` to spawn the Hermes container, detached.
 *   - `applyDockerEgressJail` to constrain outbound traffic to the same
 *     model-provider allowlist Vellum runs against. This keeps cross-species
 *     cost comparisons honest.
 *   - `docker exec <container> hermes <subcommand>` for setup, send, events,
 *     and seed-conversation actions inside the container.
 *
 * The in-container CLI surface this adapter assumes (`hermes message`,
 * `hermes events --json`, `hermes exec`, `hermes conversations new
 * --content-file`) mirrors Vellum's `assistant` CLI shape so the
 * evals harness contract stays uniform across species. The exact Hermes
 * subcommand names may differ from what this adapter spells; both the
 * docker image and the in-container CLI command are constructor-overrideable
 * via `dockerImage` and `cliCommand` so the call surface can be adjusted
 * (or a thin shim CLI dropped into the image) without rewriting the
 * adapter.
 *
 * Treat this as a structural scaffold against an unverified upstream API
 * until we've run against a real Hermes build end-to-end.
 */

export const DEFAULT_HERMES_IMAGE = "nousresearch/hermes:latest";
/** Default in-container CLI name. Overridable per profile. */
export const DEFAULT_HERMES_CLI = "hermes";

export interface HermesAgentOptions {
  profile: Profile;
  testId: string;
  runId?: string;
  runner?: CommandRunner;
  /** Docker image to run the Hermes agent from. */
  dockerImage?: string;
  /** Hermes CLI command name inside the container. */
  cliCommand?: string;
}

function setupCommands(profile: Profile): string[] {
  const setup = profile.manifest.setup;
  if (!setup) return [];
  return Array.isArray(setup) ? setup : [setup];
}

function shellWords(command: string): string[] {
  return ["sh", "-lc", command];
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function seedConversationCommand(
  cliCommand: string,
  containerSeedPath: string,
): string {
  const quotedSeedPath = shellSingleQuote(containerSeedPath);
  return [
    "set -e",
    `cleanup() { rm -f ${quotedSeedPath}; }`,
    "trap cleanup EXIT",
    `${cliCommand} conversations new --content-file ${quotedSeedPath}`,
  ].join("\n");
}

function parseConversationKey(output: string): string | null {
  const match = output.match(/conversation key: ([^\s,]+)/);
  return match?.[1] ?? null;
}

/** Container name suffix differentiates Hermes from Vellum runs side-by-side. */
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
      // Detached `docker run` so the Hermes daemon stays up across send/events.
      // The container should idle waiting for CLI interactions; outbound
      // model traffic only happens once the egress jail is in place because
      // the daemon shouldn't reach out before receiving its first message.
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
        this.dockerImage,
      ]);
      assertSuccess(create, `start Hermes container for ${this.profile.id}`);
      containerStarted = true;

      this.jail = await applyDockerEgressJail(this.runner, {
        containerName: this.containerName,
      });

      for (const command of setupCommands(this.profile)) {
        const setup = await this.runner.run("docker", [
          "exec",
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
    switch (command.type) {
      case "seed-conversation": {
        const seedDir = await mkdtemp(join(tmpdir(), "hermes-evals-seed-"));
        const seedFile = join(seedDir, "conversation.json");
        const containerSeedPath = `/tmp/${this.id}-conversation-seed.json`;
        try {
          await writeFile(seedFile, JSON.stringify(command.messages), "utf8");
          const copy = await this.runner.run("docker", [
            "cp",
            seedFile,
            `${this.containerName}:${containerSeedPath}`,
          ]);
          assertSuccess(copy, `copy seed conversation for ${this.id}`);

          const result = await this.runner.run("docker", [
            "exec",
            this.containerName,
            ...shellWords(
              seedConversationCommand(this.cliCommand, containerSeedPath),
            ),
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
    this.eventsProcess ??= this.runner.spawn("docker", [
      "exec",
      this.containerName,
      this.cliCommand,
      "events",
      "--conversation-key",
      this.conversationKey,
      "--json",
    ]);
    return parseNdjson<AgentEvent>(this.eventsProcess.stdout);
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

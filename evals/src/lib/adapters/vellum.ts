import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../adapter";
import type { Profile } from "../profile";
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

async function* emptyLines(): AsyncGenerator<string> {}

export interface VellumAgentOptions {
  profile: Profile;
  testId: string;
  runId?: string;
  runner?: CommandRunner;
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

export class VellumAgent implements BaseAgent {
  readonly id: string;
  readonly conversationKey: string;

  private readonly profile: Profile;
  private readonly runner: CommandRunner;
  private readonly cliCommand: string;
  private readonly testId: string;
  private eventsProcess?: SpawnedProcess;
  private jail?: DockerEgressJail;
  private hatched = false;
  private stopped = false;

  constructor(opts: VellumAgentOptions) {
    this.profile = opts.profile;
    this.testId = opts.testId;
    this.runner = opts.runner ?? new NodeCommandRunner();
    this.cliCommand = opts.cliCommand ?? "vellum";
    this.id =
      opts.runId ?? `eval-${opts.profile.id}-${opts.testId}-${Date.now()}`;
    this.conversationKey = `evals:${opts.testId}:${this.id}`;
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
      const hatch = await this.runner.run(this.cliCommand, [
        "hatch",
        "vellum",
        "--remote",
        "docker",
        "--name",
        this.id,
      ]);
      assertSuccess(hatch, `hatch Vellum profile ${this.profile.id}`);
      hatchStarted = true;

      this.jail = await applyDockerEgressJail(this.runner, {
        containerName: vellumDockerAssistantContainer(this.id),
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

      this.eventsProcess = this.runner.spawn(this.cliCommand, [
        "events",
        this.id,
        "--conversation-key",
        this.conversationKey,
        "--json",
      ]);
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

  events(): AsyncIterable<AgentEvent> {
    this.assertHatched();
    return parseNdjson<AgentEvent>(this.eventsProcess?.stdout ?? emptyLines());
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
    if (!this.hatched || !this.eventsProcess) {
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

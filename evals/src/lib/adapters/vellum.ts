import type {
  AgentAdapter,
  AgentEvent,
  AgentMessage,
  RunningAgent,
} from "../adapter";
import type { Profile } from "../profile";
import {
  prepareDockerEgressJail,
  vellumDockerResourceNames,
} from "../egress/docker-jail";
import {
  assertSuccess,
  NodeCommandRunner,
  type CommandRunner,
  type SpawnedProcess,
} from "../runtime/command-runner";
import { parseNdjson } from "../runtime/ndjson";

export interface VellumAdapterOptions {
  runner?: CommandRunner;
  cliCommand?: string;
  allowHosts?: string[];
}

const DEFAULT_ALLOW_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

function setupCommands(profile: Profile): string[] {
  const setup = profile.manifest.setup;
  if (!setup) return [];
  return Array.isArray(setup) ? setup : [setup];
}

function shellWords(command: string): string[] {
  return ["sh", "-lc", command];
}

export class VellumAdapter implements AgentAdapter {
  private readonly runner: CommandRunner;
  private readonly cliCommand: string;
  private readonly allowHosts: string[];

  constructor(opts: VellumAdapterOptions = {}) {
    this.runner = opts.runner ?? new NodeCommandRunner();
    this.cliCommand = opts.cliCommand ?? "vellum";
    this.allowHosts = opts.allowHosts ?? DEFAULT_ALLOW_HOSTS;
  }

  async spawn(input: {
    profile: Profile;
    testId: string;
    runId?: string;
  }): Promise<RunningAgent> {
    if (input.profile.manifest.species !== "vellum") {
      throw new Error(
        `VellumAdapter can only run species=vellum profiles (received ${input.profile.manifest.species})`,
      );
    }

    const instanceName =
      input.runId ?? `eval-${input.profile.id}-${input.testId}-${Date.now()}`;
    const resources = vellumDockerResourceNames(instanceName);
    const jail = await prepareDockerEgressJail(this.runner, {
      instanceName,
      networkName: resources.networkName,
      allowHosts: this.allowHosts,
    });

    try {
      const hatch = await this.runner.run(
        this.cliCommand,
        ["hatch", "vellum", "--remote", "docker", "--name", instanceName],
        { env: jail.env },
      );
      assertSuccess(hatch, `hatch Vellum profile ${input.profile.id}`);

      for (const command of setupCommands(input.profile)) {
        const setup = await this.runner.run(
          this.cliCommand,
          ["exec", instanceName, "--", ...shellWords(command)],
          { env: jail.env },
        );
        assertSuccess(setup, `setup command for profile ${input.profile.id}`);
      }
    } catch (err) {
      await jail.stop();
      await this.runner
        .run(this.cliCommand, ["retire", instanceName])
        .catch(() => undefined);
      throw err;
    }

    const conversationKey = `evals:${input.testId}:${instanceName}`;
    const eventsProcess = this.runner.spawn(this.cliCommand, [
      "events",
      instanceName,
      "--conversation-key",
      conversationKey,
      "--json",
    ]);

    return new VellumRunningAgent({
      runner: this.runner,
      cliCommand: this.cliCommand,
      instanceName,
      conversationKey,
      eventsProcess,
      stopJail: jail.stop,
    });
  }
}

class VellumRunningAgent implements RunningAgent {
  readonly id: string;
  readonly conversationKey: string;

  private readonly runner: CommandRunner;
  private readonly cliCommand: string;
  private readonly eventsProcess: SpawnedProcess;
  private readonly stopJail: () => Promise<void>;
  private stopped = false;

  constructor(opts: {
    runner: CommandRunner;
    cliCommand: string;
    instanceName: string;
    conversationKey: string;
    eventsProcess: SpawnedProcess;
    stopJail: () => Promise<void>;
  }) {
    this.runner = opts.runner;
    this.cliCommand = opts.cliCommand;
    this.id = opts.instanceName;
    this.conversationKey = opts.conversationKey;
    this.eventsProcess = opts.eventsProcess;
    this.stopJail = opts.stopJail;
  }

  async send(message: AgentMessage): Promise<void> {
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
    return parseNdjson<AgentEvent>(this.eventsProcess.stdout);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsProcess.kill();
    await this.stopJail();
    await this.runner
      .run(this.cliCommand, ["retire", this.id])
      .catch(() => undefined);
  }
}

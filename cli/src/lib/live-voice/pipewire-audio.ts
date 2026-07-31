import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { userInfo } from "node:os";

import { compareVersions, parseVersion } from "../version-compat.js";
import {
  LIVE_VOICE_PCM_CHANNELS,
  LIVE_VOICE_PCM_FRAME_BYTES,
  LIVE_VOICE_PCM_FRAME_DURATION_MS,
  LIVE_VOICE_PCM_MIME_TYPE,
  LIVE_VOICE_PCM_SAMPLE_RATE,
  PcmFrameRechunker,
  pcm16Rms,
} from "./audio.js";
import type {
  LiveVoiceAudioDevice,
  LiveVoiceAudioDevices,
  LiveVoiceAudioDoctorCheck,
  LiveVoiceAudioDoctorOptions,
  LiveVoiceAudioDoctorReport,
  LiveVoiceEchoCancelPair,
  LiveVoicePcmCaptureOptions,
  LiveVoicePcmCaptureSession,
  LiveVoicePcmPlayback,
  LiveVoicePlaybackChunk,
} from "./audio.js";

const REQUIRED_EXECUTABLES = [
  "pw-record",
  "pw-play",
  "pw-dump",
  "systemctl",
  "loginctl",
] as const;
const MINIMUM_PIPEWIRE_VERSION = "1.4.0";
const AUDIO_COMMAND_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_GRACE_MS = 500;
const PROCESS_FORCE_KILL_GRACE_MS = 500;
const PLAYBACK_DRAIN_GRACE_MS = 10_000;
export const LIVE_VOICE_ECHO_CANCEL_SOURCE = "vellum_echo_cancel_source";
export const LIVE_VOICE_ECHO_CANCEL_SINK = "vellum_echo_cancel_sink";
const PIPEWIRE_ECHO_CANCEL_MODULE = "libpipewire-module-echo-cancel";

export type AudioProcessFactory = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
    shell: false;
  },
) => ChildProcessWithoutNullStreams;

export type AudioExecutableLookup = (
  executable: string,
) => Promise<string | null>;

export interface AudioCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type AudioCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<AudioCommandResult>;

export interface AudioProcessProbeOptions {
  durationMs: number;
  input?: Buffer;
  requireOutput?: boolean;
}

export interface AudioProcessProbeResult {
  ok: boolean;
  detail?: string;
}

export type AudioProcessProbe = (
  executable: string,
  args: readonly string[],
  options: AudioProcessProbeOptions,
) => Promise<AudioProcessProbeResult>;

export interface PipeWireAudioDependencies {
  spawnProcess?: AudioProcessFactory;
  findExecutable?: AudioExecutableLookup;
  runCommand?: AudioCommandRunner;
  probeProcess?: AudioProcessProbe;
  platform?: NodeJS.Platform;
  architecture?: string;
  username?: string;
  runtimeDirectory?: string;
  pathExists?: (path: string) => boolean;
  processTerminationGraceMs?: number;
  processForceKillGraceMs?: number;
  playbackDrainGraceMs?: number;
}

interface AudioProcessTimeouts {
  terminationGraceMs: number;
  forceKillGraceMs: number;
  drainGraceMs: number;
}

interface AudioProcessReapResult {
  closed: boolean;
  forced: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface PipeWireVersion {
  major: number;
  minor: number;
  patch: number;
}

interface PipeWireDumpObject {
  id?: unknown;
  type?: unknown;
  info?: {
    props?: Record<string, unknown>;
  };
}

interface PipeWireDumpTopology {
  devices: LiveVoiceAudioDevices;
  echoCancelPair?: LiveVoiceEchoCancelPair;
  echoCancelFailure?: string;
}

export class PipeWireAudio {
  private readonly spawnProcess: AudioProcessFactory;
  private readonly findExecutable: AudioExecutableLookup;
  private readonly runCommand: AudioCommandRunner;
  private readonly probeProcess: AudioProcessProbe;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly username: string;
  private readonly runtimeDirectory: string | undefined;
  private readonly pathExists: (path: string) => boolean;
  private readonly processTimeouts: AudioProcessTimeouts;

  constructor(dependencies: PipeWireAudioDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
    this.findExecutable =
      dependencies.findExecutable ?? defaultExecutableLookup;
    this.runCommand =
      dependencies.runCommand ?? createDefaultCommandRunner(this.spawnProcess);
    this.probeProcess =
      dependencies.probeProcess ?? createDefaultProcessProbe(this.spawnProcess);
    this.platform = dependencies.platform ?? process.platform;
    this.architecture = dependencies.architecture ?? process.arch;
    this.username = dependencies.username ?? userInfo().username;
    this.runtimeDirectory =
      dependencies.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR;
    this.pathExists = dependencies.pathExists ?? existsSync;
    this.processTimeouts = {
      terminationGraceMs:
        dependencies.processTerminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
      forceKillGraceMs:
        dependencies.processForceKillGraceMs ?? PROCESS_FORCE_KILL_GRACE_MS,
      drainGraceMs:
        dependencies.playbackDrainGraceMs ?? PLAYBACK_DRAIN_GRACE_MS,
    };
  }

  async discoverDevices(): Promise<LiveVoiceAudioDevices> {
    const executable = await this.requireExecutable("pw-dump");
    const result = await this.runCommand(executable, [], {
      timeoutMs: AUDIO_COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          "PipeWire device discovery failed. Check the user audio session.",
      );
    }
    return parsePipeWireDevices(result.stdout);
  }

  async startCapture(
    options: LiveVoicePcmCaptureOptions,
  ): Promise<LiveVoicePcmCaptureSession> {
    const executable = await this.requireExecutable("pw-record");
    const child = this.spawnProcess(
      executable,
      buildPipeWirePcmArgs(options.target),
      pipeProcessOptions(),
    );
    return new PipeWireCaptureSession(child, options, this.processTimeouts);
  }

  createPlayback(target?: string): LiveVoicePcmPlayback {
    return new PipeWirePlayback(
      this.spawnProcess,
      this.findExecutable,
      this.processTimeouts,
      target,
    );
  }

  async doctor(
    options: LiveVoiceAudioDoctorOptions = {},
  ): Promise<LiveVoiceAudioDoctorReport> {
    const checks: LiveVoiceAudioDoctorCheck[] = [];
    const executables = new Map<string, string>();
    const addCheck = (
      id: string,
      status: LiveVoiceAudioDoctorCheck["status"],
      message: string,
    ): void => {
      checks.push({ id, status, message });
    };

    const supportedRuntime =
      this.platform === "linux" && this.architecture === "arm64";
    addCheck(
      "runtime",
      supportedRuntime ? "pass" : "fail",
      supportedRuntime
        ? "Linux ARM64 is supported."
        : `Expected Linux ARM64, found ${this.platform} ${this.architecture}.`,
    );

    const resolvedExecutables = await Promise.all(
      REQUIRED_EXECUTABLES.map(
        async (name) => [name, await this.findExecutable(name)] as const,
      ),
    );
    for (const [name, resolved] of resolvedExecutables) {
      if (resolved === null) {
        addCheck(
          `executable.${name}`,
          "fail",
          `${name} is not installed or is not executable.`,
        );
      } else {
        executables.set(name, resolved);
        addCheck(`executable.${name}`, "pass", `${name} is available.`);
      }
    }

    const pwRecord = executables.get("pw-record");
    if (pwRecord !== undefined) {
      const result = await this.runCommand(pwRecord, ["--version"], {
        timeoutMs: AUDIO_COMMAND_TIMEOUT_MS,
      });
      const version = parsePipeWireVersion(
        `${result.stdout}\n${result.stderr}`,
      );
      const versionComparison =
        version === null
          ? null
          : compareVersions(
              formatPipeWireVersion(version),
              MINIMUM_PIPEWIRE_VERSION,
            );
      const supported =
        result.code === 0 &&
        versionComparison !== null &&
        versionComparison >= 0;
      addCheck(
        "pipewire.version",
        supported ? "pass" : "fail",
        version === null
          ? "Could not determine the PipeWire version. Version 1.4 or newer is required."
          : `PipeWire ${formatPipeWireVersion(version)} ${
              supported
                ? "is supported."
                : "is too old; version 1.4 or newer is required."
            }`,
      );
    } else {
      addCheck(
        "pipewire.version",
        "skip",
        "PipeWire version was not checked because pw-record is unavailable.",
      );
    }

    const systemctl = executables.get("systemctl");
    const pipewireUnitActive =
      systemctl !== undefined &&
      (await this.anyUserUnitActive(systemctl, [
        "pipewire.service",
        "pipewire.socket",
      ]));
    const pipewireSocketActive =
      this.runtimeDirectory !== undefined &&
      this.pathExists(join(this.runtimeDirectory, "pipewire-0"));
    const pipewireSessionActive = pipewireUnitActive || pipewireSocketActive;
    addCheck(
      "session.pipewire",
      pipewireSessionActive ? "pass" : "fail",
      pipewireSessionActive
        ? "The PipeWire user session is active."
        : "The PipeWire user session is inactive. Start the user service or socket before checking hardware.",
    );

    const wirePlumberActive =
      systemctl !== undefined &&
      (await this.anyUserUnitActive(systemctl, [
        "wireplumber.service",
        "wireplumber.socket",
      ]));
    addCheck(
      "session.wireplumber",
      wirePlumberActive ? "pass" : "fail",
      wirePlumberActive
        ? "The WirePlumber user session is active."
        : "The WirePlumber user session is inactive. Start it before checking hardware.",
    );

    const loginctl = executables.get("loginctl");
    if (loginctl === undefined) {
      addCheck(
        "session.linger",
        "fail",
        "Headless user persistence could not be checked because loginctl is unavailable.",
      );
    } else {
      const result = await this.runCommand(
        loginctl,
        ["show-user", this.username, "-p", "Linger"],
        {
          timeoutMs: AUDIO_COMMAND_TIMEOUT_MS,
        },
      );
      const lingerEnabled =
        result.code === 0 &&
        /(?:^|\n)(?:Linger=)?yes(?:\n|$)/i.test(result.stdout.trim());
      addCheck(
        "session.linger",
        lingerEnabled ? "pass" : "fail",
        lingerEnabled
          ? "Headless user persistence is enabled."
          : "Headless user persistence is disabled. Enable login linger for the audio user.",
      );
    }

    let devices: LiveVoiceAudioDevices = { inputs: [], outputs: [] };
    let echoCancelPair: LiveVoiceEchoCancelPair | undefined;
    let echoCancelFailure: string | undefined;
    const pwDump = executables.get("pw-dump");
    if (!pipewireSessionActive || pwDump === undefined) {
      addCheck(
        "devices.input",
        "skip",
        "Capture hardware was not checked because the PipeWire session is unavailable.",
      );
      addCheck(
        "devices.output",
        "skip",
        "Playback hardware was not checked because the PipeWire session is unavailable.",
      );
    } else {
      try {
        const result = await this.runCommand(pwDump, [], {
          timeoutMs: AUDIO_COMMAND_TIMEOUT_MS,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "pw-dump failed");
        }
        const topology = parsePipeWireTopology(result.stdout);
        devices = topology.devices;
        echoCancelPair = topology.echoCancelPair;
        echoCancelFailure = topology.echoCancelFailure;
        addCheck(
          "devices.input",
          devices.inputs.length > 0 ? "pass" : "fail",
          devices.inputs.length > 0
            ? `Found ${devices.inputs.length} capture source(s).`
            : "The PipeWire session is active, but no capture source was found.",
        );
        addCheck(
          "devices.output",
          devices.outputs.length > 0 ? "pass" : "fail",
          devices.outputs.length > 0
            ? `Found ${devices.outputs.length} playback sink(s).`
            : "The PipeWire session is active, but no playback sink was found.",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(
          "devices.input",
          "fail",
          `Capture source discovery failed: ${message}`,
        );
        addCheck(
          "devices.output",
          "fail",
          `Playback sink discovery failed: ${message}`,
        );
      }
    }

    if (options.mode === "open-mic") {
      const source = devices.inputs.find(
        (device) => device.nodeName === LIVE_VOICE_ECHO_CANCEL_SOURCE,
      );
      const sink = devices.outputs.find(
        (device) => device.nodeName === LIVE_VOICE_ECHO_CANCEL_SINK,
      );
      addCheck(
        "aec.source",
        source?.mediaClass === "Audio/Source" ? "pass" : "fail",
        source?.mediaClass === "Audio/Source"
          ? `Found echo-cancel source ${LIVE_VOICE_ECHO_CANCEL_SOURCE}.`
          : `Open mic requires an Audio/Source node named ${LIVE_VOICE_ECHO_CANCEL_SOURCE}.`,
      );
      addCheck(
        "aec.sink",
        sink?.mediaClass === "Audio/Sink" ? "pass" : "fail",
        sink?.mediaClass === "Audio/Sink"
          ? `Found echo-cancel sink ${LIVE_VOICE_ECHO_CANCEL_SINK}.`
          : `Open mic requires an Audio/Sink node named ${LIVE_VOICE_ECHO_CANCEL_SINK}.`,
      );
      addCheck(
        "aec.module",
        echoCancelPair === undefined ? "fail" : "pass",
        echoCancelPair === undefined
          ? `${echoCancelFailure ?? "The required nodes do not share a verified echo-cancel module."} Configure one ${PIPEWIRE_ECHO_CANCEL_MODULE} instance with capture node ${LIVE_VOICE_ECHO_CANCEL_SOURCE} and playback node ${LIVE_VOICE_ECHO_CANCEL_SINK}. Use --mode push-to-talk until this check passes.`
          : `The echo-cancel nodes share ${PIPEWIRE_ECHO_CANCEL_MODULE} module ${echoCancelPair.moduleId}.`,
      );
    }

    const selectedInput =
      options.mode === "open-mic"
        ? LIVE_VOICE_ECHO_CANCEL_SOURCE
        : options.inputDevice;
    const selectedOutput =
      options.mode === "open-mic"
        ? LIVE_VOICE_ECHO_CANCEL_SINK
        : options.outputDevice;
    const input = resolveExplicitDevice(devices.inputs, selectedInput);
    const output = resolveExplicitDevice(devices.outputs, selectedOutput);
    addExplicitDeviceCheck(checks, "input", options.inputDevice, input);
    addExplicitDeviceCheck(checks, "output", options.outputDevice, output);

    const probeDurationMs = options.probeDurationMs ?? 250;
    await this.addProbeCheck({
      checks,
      id: "probe.input",
      executable: pwRecord,
      deviceAvailable:
        selectedInput === undefined
          ? devices.inputs.length > 0
          : input !== null,
      args: buildPipeWirePcmArgs(input?.nodeName),
      options: { durationMs: probeDurationMs, requireOutput: true },
      successMessage: "Capture process produced in-memory PCM.",
      unavailableMessage:
        "Capture was not probed because its tool, session, or selected device is unavailable.",
    });
    await this.addProbeCheck({
      checks,
      id: "probe.output",
      executable: executables.get("pw-play"),
      deviceAvailable:
        selectedOutput === undefined
          ? devices.outputs.length > 0
          : output !== null,
      args: buildPipeWirePcmArgs(output?.nodeName),
      options: {
        durationMs: probeDurationMs,
        input: Buffer.alloc(LIVE_VOICE_PCM_FRAME_BYTES),
      },
      successMessage: "Playback process accepted in-memory PCM.",
      unavailableMessage:
        "Playback was not probed because its tool, session, or selected device is unavailable.",
    });

    return {
      ok: checks.every(
        (check) => check.status === "pass" || check.status === "warning",
      ),
      checks,
      devices,
      ...(echoCancelPair ? { echoCancelPair } : {}),
    };
  }

  private async requireExecutable(name: string): Promise<string> {
    const executable = await this.findExecutable(name);
    if (executable === null) {
      throw new Error(
        `${name} is required for live voice. Install PipeWire 1.4 or newer.`,
      );
    }
    return executable;
  }

  private async anyUserUnitActive(
    systemctl: string,
    units: readonly string[],
  ): Promise<boolean> {
    const results = await Promise.all(
      units.map(
        async (unit) =>
          await this.runCommand(systemctl, ["--user", "is-active", unit], {
            timeoutMs: AUDIO_COMMAND_TIMEOUT_MS,
          }),
      ),
    );
    return results.some(
      (result) => result.code === 0 && result.stdout.trim() === "active",
    );
  }

  private async addProbeCheck(input: {
    checks: LiveVoiceAudioDoctorCheck[];
    id: string;
    executable: string | undefined;
    deviceAvailable: boolean;
    args: readonly string[];
    options: AudioProcessProbeOptions;
    successMessage: string;
    unavailableMessage: string;
  }): Promise<void> {
    if (
      input.executable === undefined ||
      !input.deviceAvailable ||
      !input.checks.some(
        (check) => check.id === "session.pipewire" && check.status === "pass",
      )
    ) {
      input.checks.push({
        id: input.id,
        status: "skip",
        message: input.unavailableMessage,
      });
      return;
    }

    const result = await this.probeProcess(
      input.executable,
      input.args,
      input.options,
    );
    input.checks.push({
      id: input.id,
      status: result.ok ? "pass" : "fail",
      message: result.ok
        ? input.successMessage
        : result.detail || `${input.id} failed.`,
    });
  }
}

export function parsePipeWireDevices(json: string): LiveVoiceAudioDevices {
  return parsePipeWireTopology(json).devices;
}

export function parsePipeWireEchoCancelPair(
  json: string,
): LiveVoiceEchoCancelPair | null {
  return parsePipeWireTopology(json).echoCancelPair ?? null;
}

function parsePipeWireTopology(json: string): PipeWireDumpTopology {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("pw-dump returned invalid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("pw-dump returned an unexpected payload.");
  }

  const inputs: LiveVoiceAudioDevice[] = [];
  const outputs: LiveVoiceAudioDevice[] = [];
  const echoCancelModuleIds = new Set<number>();
  for (const value of parsed as PipeWireDumpObject[]) {
    if (value === null || typeof value !== "object") {
      continue;
    }
    const properties = value.info?.props;
    if (properties === undefined) {
      continue;
    }
    if (value.type === "PipeWire:Interface:Module") {
      if (
        typeof value.id === "number" &&
        Number.isInteger(value.id) &&
        readStringProperty(properties, "module.name") ===
          PIPEWIRE_ECHO_CANCEL_MODULE
      ) {
        echoCancelModuleIds.add(value.id);
      }
      continue;
    }
    if (value.type !== "PipeWire:Interface:Node") {
      continue;
    }
    const nodeName = readStringProperty(properties, "node.name");
    const mediaClass = readStringProperty(properties, "media.class");
    const objectSerial = readScalarProperty(properties, "object.serial");
    if (nodeName === null || mediaClass === null || objectSerial === null) {
      continue;
    }

    const direction = mediaClass.startsWith("Audio/Source")
      ? "input"
      : mediaClass.startsWith("Audio/Sink")
        ? "output"
        : null;
    if (direction === null) {
      continue;
    }

    const description =
      readStringProperty(properties, "node.description") ??
      readStringProperty(properties, "node.nick") ??
      nodeName;
    const device: LiveVoiceAudioDevice = {
      direction,
      nodeName,
      objectSerial,
      description,
      mediaClass,
      objectId:
        typeof value.id === "number" && Number.isInteger(value.id)
          ? value.id
          : undefined,
      moduleId: readIntegerProperty(properties, "module.id") ?? undefined,
    };
    if (direction === "input") {
      inputs.push(device);
    } else {
      outputs.push(device);
    }
  }

  const devices = { inputs, outputs };
  const input = inputs.find(
    (device) => device.nodeName === LIVE_VOICE_ECHO_CANCEL_SOURCE,
  );
  const output = outputs.find(
    (device) => device.nodeName === LIVE_VOICE_ECHO_CANCEL_SINK,
  );
  if (input === undefined || output === undefined) {
    return {
      devices,
      echoCancelFailure:
        "The exact Vellum echo-cancel node pair was not found.",
    };
  }
  if (
    input.mediaClass !== "Audio/Source" ||
    output.mediaClass !== "Audio/Sink"
  ) {
    return {
      devices,
      echoCancelFailure:
        "The exact Vellum echo-cancel nodes have invalid media classes.",
    };
  }
  if (input.moduleId === undefined || input.moduleId !== output.moduleId) {
    return {
      devices,
      echoCancelFailure:
        "The exact Vellum echo-cancel nodes are not owned by the same module instance.",
    };
  }
  if (!echoCancelModuleIds.has(input.moduleId)) {
    return {
      devices,
      echoCancelFailure:
        "The exact Vellum echo-cancel nodes are not owned by libpipewire-module-echo-cancel.",
    };
  }
  return {
    devices,
    echoCancelPair: {
      input,
      output,
      moduleId: input.moduleId,
    },
  };
}

export function parsePipeWireVersion(output: string): PipeWireVersion | null {
  const match = output.match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (match === null) {
    return null;
  }
  const parsed = parseVersion(match[0]);
  if (parsed === null) {
    return null;
  }
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
  };
}

export function buildPipeWirePcmArgs(target?: string): string[] {
  const args = [
    "--raw",
    `--rate=${LIVE_VOICE_PCM_SAMPLE_RATE}`,
    `--channels=${LIVE_VOICE_PCM_CHANNELS}`,
    "--format=s16",
    `--latency=${LIVE_VOICE_PCM_FRAME_DURATION_MS}ms`,
  ];
  if (target !== undefined) {
    args.push(`--target=${target}`);
  }
  args.push("-");
  return args;
}

class PipeWireCaptureSession implements LiveVoicePcmCaptureSession {
  readonly closed: Promise<void>;
  private readonly framer = new PcmFrameRechunker();
  private muted = false;
  private stopping = false;
  private stopped: Promise<Buffer | null> | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: LiveVoicePcmCaptureOptions,
    private readonly processTimeouts: AudioProcessTimeouts,
  ) {
    this.closed = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      child.once("error", (error) => {
        settle(error);
      });
      child.once("close", (code, signal) => {
        if (this.stopping) {
          settle();
        } else {
          settle(
            new Error(
              `pw-record stopped unexpectedly with ${
                signal === null ? `code ${String(code)}` : `signal ${signal}`
              }.`,
            ),
          );
        }
      });
    });
    void this.closed.catch(() => {});

    child.stdout.on("data", (chunk: Buffer) => {
      for (const frame of this.framer.push(chunk, this.muted)) {
        this.options.onFrame(frame, pcm16Rms(frame));
      }
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  stop(): Promise<Buffer | null> {
    if (this.stopped !== null) {
      return this.stopped;
    }
    this.stopped = this.stopOnce();
    return this.stopped;
  }

  private async stopOnce(): Promise<Buffer | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.closed;
      return this.framer.flush(this.muted);
    }
    this.stopping = true;
    const result = await terminateAndReapProcess(
      this.child,
      () => {
        this.child.kill("SIGTERM");
      },
      this.processTimeouts.terminationGraceMs,
      this.processTimeouts.forceKillGraceMs,
    );
    if (result.closed) {
      await this.closed;
    }
    return this.framer.flush(this.muted);
  }
}

class PipeWirePlayback implements LiveVoicePcmPlayback {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sampleRate: number | null = null;
  private generation = 0;
  private operations: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly spawnProcess: AudioProcessFactory,
    private readonly findExecutable: AudioExecutableLookup,
    private readonly processTimeouts: AudioProcessTimeouts,
    private readonly target?: string,
  ) {}

  write(chunk: LiveVoicePlaybackChunk): Promise<void> {
    if (chunk.mimeType !== LIVE_VOICE_PCM_MIME_TYPE) {
      const source = chunk.provider ?? "configured speech provider";
      return Promise.reject(
        new Error(
          `${source} returned unsupported live voice audio ${chunk.mimeType} at ${chunk.sampleRate} Hz. Expected ${LIVE_VOICE_PCM_MIME_TYPE}.`,
        ),
      );
    }
    if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate <= 0) {
      return Promise.reject(
        new Error(`Invalid live voice PCM sample rate ${chunk.sampleRate}.`),
      );
    }
    if (this.closed) {
      return Promise.reject(new Error("Live voice playback is closed."));
    }

    const generation = this.generation;
    const operation = this.enqueue(async () => {
      if (generation !== this.generation) {
        return;
      }
      if (
        this.child !== null &&
        this.sampleRate !== null &&
        this.sampleRate !== chunk.sampleRate
      ) {
        await this.stopActiveProcess("SIGTERM");
      }
      const child = await this.ensureProcess(chunk.sampleRate);
      if (generation !== this.generation) {
        await this.stopActiveProcess("SIGTERM");
        return;
      }
      try {
        await writeWithBackpressure(child, chunk.audio);
      } catch (error) {
        if (generation === this.generation) {
          throw error;
        }
      }
    });
    return operation;
  }

  drain(): Promise<void> {
    return this.enqueue(async () => {
      const child = this.child;
      if (child === null) {
        return;
      }
      this.child = null;
      this.sampleRate = null;
      const result = await terminateAndReapProcess(
        child,
        () => {
          child.stdin.end();
        },
        this.processTimeouts.drainGraceMs,
        this.processTimeouts.forceKillGraceMs,
      );
      requireCleanPlaybackExit(result);
    });
  }

  flush(): Promise<void> {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.sampleRate = null;
    if (child === null) {
      return this.operations;
    }
    const result = terminateAndReapProcess(
      child,
      () => {
        child.kill("SIGTERM");
      },
      this.processTimeouts.terminationGraceMs,
      this.processTimeouts.forceKillGraceMs,
    ).then(requireTerminatedPlaybackProcess);
    this.operations = result.catch(() => {});
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.flush();
    return this.closePromise;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.catch(() => {}).then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  private async ensureProcess(
    sampleRate: number,
  ): Promise<ChildProcessWithoutNullStreams> {
    if (this.child !== null) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        return this.child;
      }
      const failed = this.child;
      this.child = null;
      this.sampleRate = null;
      throw playbackExitError(failed.exitCode, failed.signalCode);
    }
    const executable = await this.findExecutable("pw-play");
    if (executable === null) {
      throw new Error(
        "pw-play is required for live voice. Install PipeWire 1.4 or newer.",
      );
    }
    const child = this.spawnProcess(
      executable,
      buildPipeWirePcmArgsForRate(sampleRate, this.target),
      pipeProcessOptions(),
    );
    child.stdin.on("error", () => {});
    this.child = child;
    this.sampleRate = sampleRate;
    return child;
  }

  private async stopActiveProcess(signal: NodeJS.Signals): Promise<void> {
    const child = this.child;
    this.child = null;
    this.sampleRate = null;
    if (child === null) {
      return;
    }
    const result = await terminateAndReapProcess(
      child,
      () => {
        child.kill(signal);
      },
      this.processTimeouts.terminationGraceMs,
      this.processTimeouts.forceKillGraceMs,
    );
    requireTerminatedPlaybackProcess(result);
  }
}

function buildPipeWirePcmArgsForRate(
  sampleRate: number,
  target?: string,
): string[] {
  const args = buildPipeWirePcmArgs(target);
  const rateIndex = args.findIndex((arg) => arg.startsWith("--rate="));
  args[rateIndex] = `--rate=${sampleRate}`;
  return args;
}

function resolveExplicitDevice(
  devices: readonly LiveVoiceAudioDevice[],
  selected: string | undefined,
): LiveVoiceAudioDevice | null {
  if (selected === undefined) {
    return null;
  }
  return (
    devices.find(
      (device) =>
        device.nodeName === selected || device.objectSerial === selected,
    ) ?? null
  );
}

function addExplicitDeviceCheck(
  checks: LiveVoiceAudioDoctorCheck[],
  direction: "input" | "output",
  selected: string | undefined,
  resolved: LiveVoiceAudioDevice | null,
): void {
  if (selected === undefined) {
    return;
  }
  checks.push({
    id: `device.${direction}.selected`,
    status: resolved === null ? "fail" : "pass",
    message:
      resolved === null
        ? `The selected ${direction} device was not found.`
        : `Selected ${direction} device ${resolved.nodeName}.`,
  });
}

function readStringProperty(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  const value = properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readScalarProperty(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  const value = properties[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readIntegerProperty(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function formatPipeWireVersion(version: PipeWireVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function pipeProcessOptions(): SpawnOptionsWithoutStdio & {
  stdio: ["pipe", "pipe", "pipe"];
  shell: false;
} {
  return {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  };
}

const defaultSpawnProcess: AudioProcessFactory = (executable, args, options) =>
  spawn(executable, [...args], options);

async function defaultExecutableLookup(
  executable: string,
): Promise<string | null> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function createDefaultCommandRunner(
  spawnProcess: AudioProcessFactory,
): AudioCommandRunner {
  return async (executable, args, options = {}) =>
    await new Promise<AudioCommandResult>((resolve) => {
      const child = spawnProcess(executable, args, pipeProcessOptions());
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: AudioCommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(Buffer.from(chunk));
      });
      child.once("error", (error) => {
        finish({ code: null, stdout: "", stderr: error.message });
      });
      child.once("close", (code) => {
        finish({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      child.stdin.end();

      if (options.timeoutMs !== undefined) {
        if (!settled) {
          timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish({
              code: null,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: `${executable} timed out.`,
            });
          }, options.timeoutMs);
        }
      }
    });
}

function createDefaultProcessProbe(
  spawnProcess: AudioProcessFactory,
): AudioProcessProbe {
  return async (executable, args, options) =>
    await new Promise<AudioProcessProbeResult>((resolve) => {
      const child = spawnProcess(executable, args, pipeProcessOptions());
      let outputBytes = 0;
      let settled = false;
      let stopRequested = false;
      const timers: {
        stop?: ReturnType<typeof setTimeout>;
        force?: ReturnType<typeof setTimeout>;
      } = {};
      const finish = (result: AudioProcessProbeResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timers.stop !== undefined) {
          clearTimeout(timers.stop);
        }
        if (timers.force !== undefined) {
          clearTimeout(timers.force);
        }
        resolve(result);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
      });
      child.once("error", (error) => {
        finish({ ok: false, detail: error.message });
      });
      child.once("close", (code, _signal) => {
        const outputSatisfied =
          options.requireOutput !== true || outputBytes > 0;
        finish({
          ok: (code === 0 || stopRequested) && outputSatisfied,
          detail: outputSatisfied
            ? undefined
            : "The capture probe produced no PCM.",
        });
      });
      child.stdin.on("error", () => {});
      if (options.input === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(options.input);
      }
      timers.stop = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          stopRequested = true;
          child.kill("SIGTERM");
          timers.force = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 1_000);
        }
      }, options.durationMs);
    });
}

function terminateAndReapProcess(
  child: ChildProcessWithoutNullStreams,
  requestGracefulStop: () => void,
  gracefulTimeoutMs: number,
  forceKillTimeoutMs: number,
): Promise<AudioProcessReapResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      closed: true,
      forced: false,
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let forced = false;
    let processError: Error | undefined;
    const timers: {
      graceful?: ReturnType<typeof setTimeout>;
      forceKill?: ReturnType<typeof setTimeout>;
    } = {};
    const cleanup = (): void => {
      child.off("close", onClose);
      child.off("error", onError);
      if (timers.graceful !== undefined) {
        clearTimeout(timers.graceful);
      }
      if (timers.forceKill !== undefined) {
        clearTimeout(timers.forceKill);
      }
    };
    const finish = (result: AudioProcessReapResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      finish({ closed: true, forced, code, signal, error: processError });
    };
    const onError = (error: Error): void => {
      processError ??= error;
    };
    child.once("close", onClose);
    child.on("error", onError);

    const forceKill = (): void => {
      if (settled) {
        return;
      }
      forced = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
      timers.forceKill = setTimeout(
        () => {
          finish({
            closed: false,
            forced: true,
            code: child.exitCode,
            signal: child.signalCode,
            error: processError,
          });
        },
        Math.max(0, forceKillTimeoutMs),
      );
    };

    try {
      requestGracefulStop();
      timers.graceful = setTimeout(forceKill, Math.max(0, gracefulTimeoutMs));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      forceKill();
    }
  });
}

function requireCleanPlaybackExit(result: AudioProcessReapResult): void {
  if (result.error !== undefined) {
    throw result.error;
  }
  if (!result.closed) {
    throw new Error("pw-play did not exit after SIGKILL.");
  }
  if (result.code !== 0 || result.signal !== null) {
    throw playbackExitError(result.code, result.signal);
  }
}

function requireTerminatedPlaybackProcess(
  result: AudioProcessReapResult,
): void {
  if (result.error !== undefined) {
    throw result.error;
  }
  if (!result.closed) {
    throw new Error("pw-play did not exit after SIGKILL.");
  }
}

function writeWithBackpressure(
  child: ChildProcessWithoutNullStreams,
  audio: Buffer,
): Promise<void> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.stdin.destroyed
  ) {
    return Promise.reject(
      new Error("pw-play stopped before audio could be written."),
    );
  }
  const accepted = child.stdin.write(audio);
  if (accepted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      child.stdin.off("drain", onDrain);
      child.stdin.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onDrain = (): void => {
      finish();
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    const onClose = (): void => {
      finish(new Error("pw-play stopped while audio was buffered."));
    };
    child.stdin.once("drain", onDrain);
    child.stdin.once("error", onError);
    child.once("close", onClose);
  });
}

function playbackExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  return new Error(
    `pw-play stopped unexpectedly with ${
      signal === null ? `code ${String(code)}` : `signal ${signal}`
    }.`,
  );
}

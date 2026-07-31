import type { ReadStream, WriteStream } from "node:tty";

import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { GATEWAY_PORT } from "../lib/constants.js";
import {
  LiveVoiceChannelClient,
  type LiveVoiceChannelClientOptions,
} from "../lib/live-voice/channel-client.js";
import {
  resolveLiveVoiceConnection,
  type LiveVoiceResolvedConnection,
} from "../lib/live-voice/connection.js";
import {
  LIVE_VOICE_ECHO_CANCEL_SINK,
  LIVE_VOICE_ECHO_CANCEL_SOURCE,
  PipeWireAudio,
} from "../lib/live-voice/pipewire-audio.js";
import {
  LIVE_VOICE_CAPTION_MODES,
  LiveVoiceForegroundSession,
  type LiveVoiceCaptionMode,
  type LiveVoiceForegroundState,
  type LiveVoiceMode,
  type LiveVoiceSessionChannel,
  type LiveVoiceSessionEndpoint,
  type LiveVoiceTimingMetric,
} from "../lib/live-voice/session.js";
import type {
  EchoMeasurementSummary,
  LiveVoiceAudioDeviceDiscovery,
  LiveVoiceAudioDevices,
  LiveVoiceAudioDiagnostics,
  LiveVoiceAudioDoctorReport,
  LiveVoicePcmCapture,
  LiveVoicePcmPlaybackFactory,
} from "../lib/live-voice/audio.js";

const VALUE_FLAGS = [
  "--input-device",
  "--output-device",
  "--conversation",
  "--captions",
  "--mode",
  "--url",
  "-u",
  "--assistant-id",
  "-a",
  "--token",
  "-t",
] as const;
const DOCTOR_SESSION_RELEASE_TIMEOUT_MS = 2_000;

type VoiceSubcommand = "session" | "devices" | "doctor";
type VoiceCommandChannel = LiveVoiceSessionChannel &
  Pick<LiveVoiceChannelClient, "requestEnd">;

interface ParsedVoiceArgs {
  subcommand: VoiceSubcommand;
  target?: string;
  inputDevice?: string;
  outputDevice?: string;
  conversationId?: string;
  captions: LiveVoiceCaptionMode;
  mode: LiveVoiceMode;
  url?: string;
  assistantId?: string;
  guardianToken?: string;
  json: boolean;
  help: boolean;
}

interface VoiceInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  off(event: "data", listener: (chunk: Buffer | string) => void): this;
  off(event: "end" | "close", listener: () => void): this;
}

interface VoiceOutput {
  readonly isTTY?: boolean;
  write(value: string): boolean;
}

interface VoiceSignalHost {
  exitCode?: string | number | null;
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

type VoiceAudio = LiveVoiceAudioDeviceDiscovery &
  LiveVoiceAudioDiagnostics &
  LiveVoicePcmCapture &
  LiveVoicePcmPlaybackFactory;

export interface VoiceCommandDependencies {
  readonly args?: readonly string[];
  readonly audio?: VoiceAudio;
  readonly resolveConnection?: typeof resolveLiveVoiceConnection;
  readonly createChannel?: (
    options: LiveVoiceChannelClientOptions,
  ) => VoiceCommandChannel;
  readonly stdin?: VoiceInput;
  readonly stdout?: VoiceOutput;
  readonly stderr?: VoiceOutput;
  readonly signalHost?: VoiceSignalHost;
  readonly debug?: boolean;
}

interface VoiceTargetReport {
  readonly status: "ready" | "busy" | "fail";
  readonly assistantId?: string;
  readonly topology?: LiveVoiceResolvedConnection["topology"];
  readonly preflight?: string;
  readonly message?: string;
}

interface VoiceDoctorReport {
  readonly ok: boolean;
  readonly target: VoiceTargetReport;
  readonly audio?: LiveVoiceAudioDoctorReport;
}

export async function voice(
  dependencyOverrides: VoiceCommandDependencies = {},
): Promise<void> {
  const args = parseVoiceArgs(
    dependencyOverrides.args ?? process.argv.slice(3),
  );
  const stdout = dependencyOverrides.stdout ?? (process.stdout as WriteStream);
  const stderr = dependencyOverrides.stderr ?? (process.stderr as WriteStream);
  const audio = dependencyOverrides.audio ?? new PipeWireAudio();
  const resolveConnection =
    dependencyOverrides.resolveConnection ?? resolveLiveVoiceConnection;
  const createChannel =
    dependencyOverrides.createChannel ??
    ((options) => new LiveVoiceChannelClient(options));

  if (args.help) {
    printVoiceHelp(stdout);
    return;
  }
  if (args.subcommand === "devices") {
    await showDevices(args, audio, stdout);
    return;
  }

  const connectionOptions = {
    ...(args.target ? { target: args.target } : {}),
    ...(args.url ? { url: args.url } : {}),
    ...(args.assistantId ? { assistantId: args.assistantId } : {}),
    ...(args.guardianToken ? { guardianToken: args.guardianToken } : {}),
  };

  if (args.subcommand === "doctor") {
    await runDoctor({
      args,
      audio,
      stdout,
      resolveConnection,
      createChannel,
      connectionOptions,
      signalHost: dependencyOverrides.signalHost ?? process,
    });
    return;
  }

  const stdin = dependencyOverrides.stdin ?? (process.stdin as ReadStream);
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Live voice requires an interactive terminal for foreground controls.",
    );
  }

  const initialConnection = await resolveConnection(connectionOptions);
  const audioReport = await audio.doctor({
    inputDevice: args.inputDevice,
    outputDevice: args.outputDevice,
    ...(args.mode === "open-mic" ? { mode: args.mode } : {}),
  });
  if (!audioReport.ok) {
    throw new Error(formatAudioDoctorFailure(audioReport));
  }

  const endpointResolver = createEndpointResolver(
    initialConnection,
    connectionOptions,
    resolveConnection,
  );
  const inputDevice =
    args.mode === "open-mic"
      ? audioReport.echoCancelPair?.input.nodeName
      : args.inputDevice;
  const outputDevice =
    args.mode === "open-mic"
      ? audioReport.echoCancelPair?.output.nodeName
      : args.outputDevice;
  if (
    args.mode === "open-mic" &&
    (inputDevice !== LIVE_VOICE_ECHO_CANCEL_SOURCE ||
      outputDevice !== LIVE_VOICE_ECHO_CANCEL_SINK)
  ) {
    throw new Error(
      "Open mic requires the verified Vellum PipeWire echo-cancel pair. Run 'vellum voice doctor --mode open-mic' and use --mode push-to-talk until it passes.",
    );
  }
  const playback = audio.createPlayback(outputDevice);
  const writeLine = (value: string): void => {
    stdout.write(`${value}\n`);
  };
  const writeError = (value: string): void => {
    stderr.write(`${value}\n`);
  };
  let microphoneIndicator =
    args.mode === "open-mic" ? formatMicrophoneIndicator(false) : null;
  const writeSessionLine = (value: string): void => {
    writeLine(
      microphoneIndicator === null ? value : `${microphoneIndicator} ${value}`,
    );
  };
  const debug =
    dependencyOverrides.debug ??
    ["1", "true", "yes", "on"].includes(
      (process.env.VELLUM_DEBUG ?? "").toLowerCase(),
    );
  const session = new LiveVoiceForegroundSession({
    resolveEndpoint: endpointResolver,
    createChannel: (endpoint) =>
      createChannel({
        url: endpoint.url,
        ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      }),
    capture: audio,
    playback,
    mode: args.mode,
    ...(inputDevice ? { inputDevice } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    captions: args.captions,
    onState: (state) => {
      writeSessionLine(formatVoiceState(state));
    },
    onCaptionMode: (mode) => {
      writeSessionLine(`captions: ${mode}`);
    },
    onCaption: (role, text) => {
      writeSessionLine(`${role}: ${text}`);
    },
    onTiming: (metric) => {
      if (debug) {
        writeError(formatTimingMetric(metric));
      }
    },
    onModeChange: (mode, reason) => {
      if (mode === "push-to-talk") {
        microphoneIndicator = null;
      }
      writeError(`voice mode: ${reason}`);
    },
    onMicrophoneState: (muted) => {
      microphoneIndicator = formatMicrophoneIndicator(muted);
      writeLine(microphoneIndicator);
    },
    onEchoSummary: (summary) => {
      if (debug) {
        writeError(formatEchoSummary(summary));
      }
    },
    onError: (error) => {
      writeError(`voice error: ${error.message}`);
    },
  });

  try {
    await session.start();
    if (
      debug &&
      session.currentMode === "open-mic" &&
      audioReport.echoCancelPair
    ) {
      writeError(
        `[voice:aec] source=${audioReport.echoCancelPair.input.nodeName} sourceSerial=${audioReport.echoCancelPair.input.objectSerial} sink=${audioReport.echoCancelPair.output.nodeName} sinkSerial=${audioReport.echoCancelPair.output.objectSerial} module=${audioReport.echoCancelPair.moduleId}`,
      );
    }
    writeSessionLine(
      session.currentMode === "open-mic"
        ? "m: mute | s: interrupt | c: captions | q: quit"
        : "Enter: talk or release | s: interrupt | c: captions | q: quit",
    );
    await runRawTerminal({
      session,
      stdin,
      signalHost: dependencyOverrides.signalHost ?? process,
    });
  } finally {
    await session.shutdown();
  }
  if (session.fatalError !== null) {
    throw session.fatalError;
  }
}

function parseVoiceArgs(rawArgs: readonly string[]): ParsedVoiceArgs {
  const args = [...rawArgs];
  let subcommand: VoiceSubcommand = "session";
  if (args[0] === "devices" || args[0] === "doctor") {
    subcommand = args.shift() as "devices" | "doctor";
  }

  const parsed: ParsedVoiceArgs = {
    subcommand,
    captions: "off",
    mode: "push-to-talk",
    json: false,
    help: false,
  };
  const positionalArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      if (subcommand === "session") {
        throw new Error(
          "--json is supported only by voice devices and doctor.",
        );
      }
      parsed.json = true;
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      assignValueFlag(parsed, arg, value);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown voice option '${arg}'.`);
    }
    positionalArgs.push(arg);
  }

  parsed.target = parseAssistantTargetArg(positionalArgs);
  if (parsed.assistantId && !parsed.url) {
    parsed.target = parsed.assistantId;
  }
  if (subcommand === "devices" && parsed.target) {
    throw new Error("voice devices does not accept an assistant target.");
  }
  if (
    subcommand === "devices" &&
    (parsed.inputDevice ||
      parsed.outputDevice ||
      parsed.conversationId ||
      parsed.url ||
      parsed.assistantId ||
      parsed.guardianToken ||
      parsed.captions !== "off" ||
      parsed.mode !== "push-to-talk")
  ) {
    throw new Error("voice devices accepts only --json and --help.");
  }
  if (
    subcommand === "doctor" &&
    (parsed.conversationId || parsed.captions !== "off")
  ) {
    throw new Error(
      "voice doctor does not accept --conversation or --captions.",
    );
  }
  if (
    parsed.mode === "open-mic" &&
    (parsed.inputDevice !== undefined || parsed.outputDevice !== undefined)
  ) {
    throw new Error(
      "Open mic always uses the verified Vellum echo-cancel source and sink. Remove --input-device and --output-device.",
    );
  }
  return parsed;
}

function assignValueFlag(
  parsed: ParsedVoiceArgs,
  flag: string,
  value: string,
): void {
  if (flag === "--input-device") {
    parsed.inputDevice = value;
  } else if (flag === "--output-device") {
    parsed.outputDevice = value;
  } else if (flag === "--conversation") {
    parsed.conversationId = value;
  } else if (flag === "--captions") {
    if (!(LIVE_VOICE_CAPTION_MODES as readonly string[]).includes(value)) {
      throw new Error(
        `Invalid captions mode '${value}'. Expected off, user, assistant, or both.`,
      );
    }
    parsed.captions = value as LiveVoiceCaptionMode;
  } else if (flag === "--mode") {
    if (value !== "push-to-talk" && value !== "open-mic") {
      throw new Error(
        `Invalid voice mode '${value}'. Expected push-to-talk or open-mic.`,
      );
    }
    parsed.mode = value;
  } else if (flag === "--url" || flag === "-u") {
    parsed.url = value;
  } else if (flag === "--assistant-id" || flag === "-a") {
    parsed.assistantId = value;
  } else if (flag === "--token" || flag === "-t") {
    parsed.guardianToken = value;
  }
}

async function showDevices(
  args: ParsedVoiceArgs,
  audio: VoiceAudio,
  stdout: VoiceOutput,
): Promise<void> {
  const devices = await audio.discoverDevices();
  if (args.json) {
    stdout.write(`${JSON.stringify(devices, null, 2)}\n`);
    return;
  }
  printDeviceGroup(stdout, "Input devices", devices.inputs);
  printDeviceGroup(stdout, "Output devices", devices.outputs);
}

function printDeviceGroup(
  stdout: VoiceOutput,
  title: string,
  devices: LiveVoiceAudioDevices["inputs"],
): void {
  stdout.write(`${title}:\n`);
  if (devices.length === 0) {
    stdout.write("  none\n");
    return;
  }
  for (const device of devices) {
    stdout.write(
      `  ${device.nodeName}  ${device.description}  serial=${device.objectSerial}\n`,
    );
  }
}

async function runDoctor(input: {
  args: ParsedVoiceArgs;
  audio: VoiceAudio;
  stdout: VoiceOutput;
  resolveConnection: typeof resolveLiveVoiceConnection;
  createChannel: (
    options: LiveVoiceChannelClientOptions,
  ) => VoiceCommandChannel;
  connectionOptions: Parameters<typeof resolveLiveVoiceConnection>[0];
  signalHost: VoiceSignalHost;
}): Promise<void> {
  let connection: LiveVoiceResolvedConnection;
  try {
    connection = await input.resolveConnection(input.connectionOptions);
  } catch (error) {
    const report: VoiceDoctorReport = {
      ok: false,
      target: {
        status: "fail",
        message: safeErrorMessage(error),
      },
    };
    printDoctorReport(input.stdout, report, input.args.json);
    input.signalHost.exitCode = 1;
    return;
  }

  const [audioReport, readiness] = await Promise.all([
    input.audio.doctor({
      inputDevice: input.args.inputDevice,
      outputDevice: input.args.outputDevice,
      ...(input.args.mode === "open-mic" ? { mode: input.args.mode } : {}),
    }),
    probeReadiness(connection.webSocket, input.createChannel, input.args.mode),
  ]);
  const target: VoiceTargetReport = {
    ...readiness,
    assistantId: connection.assistantId,
    topology: connection.topology,
    ...(connection.topology === "direct"
      ? { preflight: connection.preflight.status }
      : {}),
  };
  const report: VoiceDoctorReport = {
    ok: audioReport.ok && readiness.status === "ready",
    target,
    audio: audioReport,
  };
  printDoctorReport(input.stdout, report, input.args.json);
  if (!report.ok) {
    input.signalHost.exitCode = 1;
  }
}

async function probeReadiness(
  endpoint: LiveVoiceSessionEndpoint,
  createChannel: (
    options: LiveVoiceChannelClientOptions,
  ) => VoiceCommandChannel,
  mode: LiveVoiceMode,
): Promise<VoiceTargetReport> {
  const channel = createChannel({
    url: endpoint.url,
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
  });
  return new Promise<VoiceTargetReport>((resolve) => {
    let settled = false;
    let readySessionId: string | null = null;
    let readyResult: VoiceTargetReport = { status: "ready" };
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: VoiceTargetReport): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      resolve(result);
    };
    channel.on("ready", (frame) => {
      if (mode === "open-mic" && frame.turnDetection !== "server_vad") {
        readyResult = {
          status: "fail",
          message:
            "The assistant did not confirm server voice activity detection. Use --mode push-to-talk or update the assistant.",
        };
      }
      readySessionId = frame.sessionId;
      channel.requestEnd();
      releaseTimer = setTimeout(() => {
        finish({
          status: "fail",
          message: `The readiness session did not confirm release within ${DOCTOR_SESSION_RELEASE_TIMEOUT_MS}ms.`,
        });
        channel.close();
      }, DOCTOR_SESSION_RELEASE_TIMEOUT_MS);
    });
    channel.on("busy", (frame) => {
      finish({
        status: "busy",
        message: `Another live-voice session is active (${frame.activeSessionId}).`,
      });
    });
    channel.on("error", (event) => {
      finish({ status: "fail", message: event.message });
      channel.close();
    });
    channel.on("frame", (frame) => {
      if (
        frame.type === "session_released" &&
        frame.sessionId === readySessionId
      ) {
        finish(readyResult);
        channel.close();
      }
    });
    channel.on("closed", (event) => {
      finish({
        status: "fail",
        message: event.reason || "The readiness connection closed.",
      });
    });
    channel.connect({
      turnDetection: mode === "open-mic" ? "server_vad" : "manual",
    });
  });
}

function printDoctorReport(
  stdout: VoiceOutput,
  report: VoiceDoctorReport,
  json: boolean,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write(`Target: ${report.target.status}\n`);
  if (report.target.assistantId && report.target.topology) {
    stdout.write(
      `  ${report.target.assistantId} (${report.target.topology})\n`,
    );
  }
  if (report.target.preflight) {
    stdout.write(`  preflight: ${report.target.preflight}\n`);
  }
  if (report.target.message) {
    stdout.write(`  ${report.target.message}\n`);
  }
  for (const check of report.audio?.checks ?? []) {
    stdout.write(`Audio ${check.status}: ${check.message}\n`);
  }
  stdout.write(report.ok ? "Voice doctor passed.\n" : "Voice doctor failed.\n");
}

function createEndpointResolver(
  initialConnection: LiveVoiceResolvedConnection,
  connectionOptions: Parameters<typeof resolveLiveVoiceConnection>[0],
  resolveConnection: typeof resolveLiveVoiceConnection,
): () => Promise<LiveVoiceSessionEndpoint> {
  let firstEndpoint: LiveVoiceSessionEndpoint | null =
    initialConnection.webSocket;
  return async () => {
    if (firstEndpoint !== null) {
      const endpoint = firstEndpoint;
      firstEndpoint = null;
      return endpoint;
    }
    if (initialConnection.topology === "direct") {
      return initialConnection.webSocket;
    }
    const refreshed = await resolveConnection(connectionOptions);
    if (refreshed.topology !== "vellum-managed") {
      throw new Error("The live-voice target topology changed.");
    }
    return refreshed.webSocket;
  };
}

async function runRawTerminal(input: {
  session: LiveVoiceForegroundSession;
  stdin: VoiceInput;
  signalHost: VoiceSignalHost;
}): Promise<void> {
  const wasRaw = input.stdin.isRaw === true;
  let stopping = false;
  const stop = (exitCode?: number): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (exitCode !== undefined) {
      input.signalHost.exitCode = exitCode;
    }
    void input.session.shutdown();
  };
  const handleData = (chunk: Buffer | string): void => {
    for (const byte of Buffer.from(chunk)) {
      if (byte === 3) {
        stop(130);
      } else if (byte === 10 || byte === 13) {
        void input.session.handleKey("enter");
      } else {
        const key = String.fromCharCode(byte).toLowerCase();
        if (key === "s") {
          void input.session.handleKey("interrupt");
        } else if (key === "m") {
          void input.session.handleKey("mute");
        } else if (key === "c") {
          void input.session.handleKey("captions");
        } else if (key === "q") {
          stop();
        }
      }
    }
  };
  const handleInputLoss = (): void => {
    stop(1);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>([
    ["SIGINT", () => stop(130)],
    ["SIGTERM", () => stop(143)],
    ["SIGHUP", () => stop(129)],
  ]);

  let rawModeSet = false;
  let listenersInstalled = false;
  try {
    input.stdin.setRawMode(true);
    rawModeSet = true;
    listenersInstalled = true;
    input.stdin.on("data", handleData);
    input.stdin.on("end", handleInputLoss);
    input.stdin.on("close", handleInputLoss);
    for (const [signal, handler] of signalHandlers) {
      input.signalHost.on(signal, handler);
    }
    input.stdin.resume();
    await input.session.waitUntilClosed();
  } finally {
    try {
      if (listenersInstalled) {
        input.stdin.off("data", handleData);
        input.stdin.off("end", handleInputLoss);
        input.stdin.off("close", handleInputLoss);
        for (const [signal, handler] of signalHandlers) {
          input.signalHost.off(signal, handler);
        }
      }
      if (rawModeSet) {
        input.stdin.setRawMode(wasRaw);
      }
      input.stdin.pause();
    } finally {
      await input.session.shutdown();
    }
  }
}

function printVoiceHelp(stdout: VoiceOutput): void {
  stdout.write("Usage: vellum voice [<name-or-id>] [options]\n");
  stdout.write("       vellum voice devices [--json]\n");
  stdout.write("       vellum voice doctor [<name-or-id>] [options]\n");
  stdout.write("\n");
  stdout.write(
    "Talk to a local or Vellum-managed assistant with foreground voice controls.\n",
  );
  stdout.write("\n");
  stdout.write("Arguments:\n");
  stdout.write(
    "  <name-or-id>                 Assistant display name or exact ID. Uses the active assistant when omitted.\n",
  );
  stdout.write("\n");
  stdout.write("Options:\n");
  stdout.write(
    "  --input-device <node>        PipeWire input node name or object serial.\n",
  );
  stdout.write(
    "  --output-device <node>       PipeWire output node name or object serial.\n",
  );
  stdout.write(
    "  --conversation <id>          Continue an existing conversation ID.\n",
  );
  stdout.write(
    "  --captions <mode>            off, user, assistant, or both. Default: off.\n",
  );
  stdout.write(
    "  --mode <mode>                push-to-talk or open-mic. Default: push-to-talk.\n",
  );
  stdout.write(
    "  -u, --url <url>              Direct gateway URL. Requires an assistant ID.\n",
  );
  stdout.write(
    "  -a, --assistant-id <id>      Exact assistant ID or ID paired with --url.\n",
  );
  stdout.write(
    "  -t, --token <token>          Ephemeral guardian token for a direct gateway. Never persisted.\n",
  );
  stdout.write(
    "  --json                       Machine-readable output for devices or doctor.\n",
  );
  stdout.write("  -h, --help                   Show this help.\n");
  stdout.write("\n");
  stdout.write(
    "Vellum-managed assistants use the stored login from 'vellum login'.\n",
  );
  stdout.write(
    "Push-to-talk uses Enter to start or release capture. Open mic uses m to mute. Both modes use s to interrupt, c to cycle captions, and q to exit.\n",
  );
  stdout.write("\n");
  stdout.write("Examples:\n");
  stdout.write("  vellum voice assistant-123\n");
  stdout.write("  vellum voice doctor assistant-123 --mode open-mic\n");
  stdout.write(
    `  vellum voice --url http://127.0.0.1:${GATEWAY_PORT} --assistant-id assistant-123\n`,
  );
  stdout.write("  vellum voice doctor assistant-123 --json\n");
}

function formatAudioDoctorFailure(report: LiveVoiceAudioDoctorReport): string {
  const failures = report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.message);
  return failures.length > 0
    ? `Voice audio diagnostics failed: ${failures.join(" ")}`
    : "Voice audio diagnostics failed.";
}

function formatVoiceState(state: LiveVoiceForegroundState): string {
  const messages: Record<LiveVoiceForegroundState, string> = {
    ready: "ready",
    listening: "listening",
    transcribing: "transcribing",
    thinking: "thinking",
    speaking: "speaking",
    busy: "busy: waiting for the previous session to release",
    failed: "failed",
    ended: "ended",
  };
  return messages[state];
}

function formatTimingMetric(metric: LiveVoiceTimingMetric): string {
  return `[voice:timing] ${metric.name}=${metric.durationMs}ms`;
}

function formatMicrophoneIndicator(muted: boolean): string {
  return muted ? "[MUTED]" : "[MIC LIVE]";
}

function formatEchoSummary(summary: EchoMeasurementSummary): string {
  const format = (value: number | null): string =>
    value === null ? "n/a" : value.toFixed(4);
  return `[voice:echo] samples=${summary.sampleCount} floor=${format(summary.microphoneFloor)} mean=${format(summary.meanMicrophoneDuringPlayback)} peak=${format(summary.peakMicrophoneDuringPlayback)} dbAboveFloor=${format(summary.decibelsAboveFloor)} correlation=${format(summary.playbackMicrophoneCorrelation)}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

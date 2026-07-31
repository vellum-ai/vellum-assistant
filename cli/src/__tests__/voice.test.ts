import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import { voice } from "../commands/voice.js";
import type {
  LiveVoiceChannelClientEventHandler,
  LiveVoiceChannelClientEventMap,
  LiveVoiceChannelClientEventName,
} from "../lib/live-voice/channel-client.js";
import type {
  LiveVoiceAudioDoctorReport,
  LiveVoicePcmCaptureOptions,
  LiveVoicePcmCaptureSession,
  LiveVoicePlaybackChunk,
} from "../lib/live-voice/audio.js";
import type { LiveVoiceSessionChannel } from "../lib/live-voice/session.js";

class FakeInput extends EventEmitter {
  readonly isTTY: boolean;
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;

  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModes.push(mode);
  }

  resume(): void {
    this.resumeCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }
}

class FakeOutput {
  readonly isTTY: boolean;
  value = "";

  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }

  write(value: string): boolean {
    this.value += value;
    return true;
  }
}

class FakeSignalHost extends EventEmitter {
  exitCode: string | number | null | undefined;
}

class FakeCaptureSession implements LiveVoicePcmCaptureSession {
  readonly closed = new Promise<void>(() => {});
  stopCount = 0;

  setMuted(): void {}

  async stop(): Promise<Buffer | null> {
    this.stopCount += 1;
    return Buffer.from([9, 10]);
  }
}

const PASSING_AUDIO_REPORT: LiveVoiceAudioDoctorReport = {
  ok: true,
  checks: [
    {
      id: "runtime",
      status: "pass",
      message: "Linux ARM64 is supported.",
    },
  ],
  devices: {
    inputs: [
      {
        direction: "input",
        nodeName: "input.node",
        objectSerial: "101",
        description: "Input",
        mediaClass: "Audio/Source",
      },
    ],
    outputs: [
      {
        direction: "output",
        nodeName: "output.node",
        objectSerial: "202",
        description: "Output",
        mediaClass: "Audio/Sink",
      },
    ],
  },
};

class FakeAudio {
  readonly doctorOptions: unknown[] = [];
  readonly captureOptions: LiveVoicePcmCaptureOptions[] = [];
  readonly captureSessions: FakeCaptureSession[] = [];
  readonly playbackTargets: Array<string | undefined> = [];
  playbackDrainCount = 0;
  playbackFlushCount = 0;
  playbackCloseCount = 0;

  async discoverDevices() {
    return PASSING_AUDIO_REPORT.devices;
  }

  async doctor(options?: {
    inputDevice?: string;
    outputDevice?: string;
  }): Promise<LiveVoiceAudioDoctorReport> {
    this.doctorOptions.push(options);
    return PASSING_AUDIO_REPORT;
  }

  async startCapture(
    options: LiveVoicePcmCaptureOptions,
  ): Promise<LiveVoicePcmCaptureSession> {
    const session = new FakeCaptureSession();
    this.captureOptions.push(options);
    this.captureSessions.push(session);
    return session;
  }

  createPlayback(target?: string) {
    this.playbackTargets.push(target);
    return {
      write: async (_chunk: LiveVoicePlaybackChunk) => {},
      drain: async () => {
        this.playbackDrainCount += 1;
      },
      flush: async () => {
        this.playbackFlushCount += 1;
      },
      close: async () => {
        this.playbackCloseCount += 1;
      },
    };
  }
}

class FakeChannel implements LiveVoiceSessionChannel {
  readonly connectOptions: unknown[] = [];
  readonly audio: Uint8Array[] = [];
  pttReleaseCount = 0;
  interruptCount = 0;
  endCount = 0;
  requestEndCount = 0;
  closeCount = 0;

  private readonly listeners: {
    [EventName in LiveVoiceChannelClientEventName]: Set<
      LiveVoiceChannelClientEventHandler<EventName>
    >;
  } = {
    ready: new Set(),
    busy: new Set(),
    frame: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(
    private readonly sessionId = "session-1",
    private readonly conversationId = "conversation-1",
    private readonly autoReleaseConfirmation = true,
  ) {}

  on<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    handler: LiveVoiceChannelClientEventHandler<EventName>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  connect(options?: {
    readonly conversationId?: string;
    readonly turnDetection?: "manual" | "server_vad";
  }): void {
    this.connectOptions.push(options);
    queueMicrotask(() => {
      this.emit("ready", {
        type: "ready",
        seq: 1,
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        turnDetection: "manual",
      });
    });
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): void {
    this.audio.push(
      pcm instanceof Uint8Array ? Buffer.from(pcm) : new Uint8Array(pcm),
    );
  }

  pttRelease(): void {
    this.pttReleaseCount += 1;
  }

  interrupt(): void {
    this.interruptCount += 1;
  }

  requestEnd(): void {
    this.requestEndCount += 1;
    if (this.autoReleaseConfirmation) {
      queueMicrotask(() => {
        this.emitSessionReleased();
      });
    }
  }

  end(): void {
    this.endCount += 1;
    this.emit("closed", {
      code: null,
      reason: "client closed",
      retryable: false,
    });
  }

  close(): void {
    this.closeCount += 1;
  }

  emit<EventName extends LiveVoiceChannelClientEventName>(
    event: EventName,
    payload: LiveVoiceChannelClientEventMap[EventName],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  emitSessionReleased(): void {
    this.emit("frame", {
      type: "session_released",
      seq: 2,
      sessionId: this.sessionId,
    });
  }
}

function directConnection(secret = "guardian-secret") {
  return {
    topology: "direct" as const,
    assistantId: "assistant-123",
    gatewayUrl: "http://127.0.0.1:7821/",
    preflight: { status: "ready" as const },
    webSocket: {
      url: "ws://127.0.0.1:7821/v1/live-voice",
      logSafeUrl: "ws://127.0.0.1:7821/v1/live-voice",
      headers: { Authorization: `Bearer ${secret}` },
    },
  };
}

async function waitFor(
  condition: () => boolean,
  message = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

describe("vellum voice", () => {
  test("prints complete help for sessions, devices, and doctor", async () => {
    const stdout = new FakeOutput();

    await voice({ args: ["--help"], stdout });

    expect(stdout.value).toContain(
      "Usage: vellum voice [<name-or-id>] [options]",
    );
    expect(stdout.value).toContain("vellum voice devices [--json]");
    expect(stdout.value).toContain("--input-device <node>");
    expect(stdout.value).toContain("--captions <mode>");
    expect(stdout.value).toContain("--assistant-id assistant-123");
  });

  test("lists PipeWire devices as JSON without requiring a TTY", async () => {
    const stdout = new FakeOutput(false);
    const audio = new FakeAudio();

    await voice({
      args: ["devices", "--json"],
      stdout,
      audio,
    });

    const result = JSON.parse(stdout.value) as {
      inputs: Array<{ nodeName: string }>;
      outputs: Array<{ nodeName: string }>;
    };
    expect(result.inputs[0].nodeName).toBe("input.node");
    expect(result.outputs[0].nodeName).toBe("output.node");
  });

  test("requires a TTY before target resolution or audio capture", async () => {
    const audio = new FakeAudio();
    let resolutionCount = 0;

    await expect(
      voice({
        args: ["assistant-123"],
        stdin: new FakeInput(false),
        stdout: new FakeOutput(false),
        audio,
        resolveConnection: async () => {
          resolutionCount += 1;
          return directConnection();
        },
      }),
    ).rejects.toThrow("interactive terminal");

    expect(resolutionCount).toBe(0);
    expect(audio.doctorOptions).toEqual([]);
    expect(audio.captureSessions).toEqual([]);
  });

  test("runs target and audio diagnostics before raw mode and capture", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();
    const signalHost = new FakeSignalHost();
    const audio = new FakeAudio();
    const channels: FakeChannel[] = [];
    const events: string[] = [];
    let resolvedOptions: unknown;

    const running = voice({
      args: [
        "Example",
        "Assistant",
        "--input-device",
        "input.node",
        "--output-device",
        "output.node",
        "--conversation",
        "conversation-requested",
        "--captions",
        "off",
        "--url",
        "http://127.0.0.1:7821",
        "--assistant-id",
        "assistant-123",
        "--token",
        "guardian-secret",
      ],
      stdin,
      stdout,
      stderr,
      signalHost,
      audio: {
        ...audio,
        discoverDevices: audio.discoverDevices.bind(audio),
        doctor: async (options) => {
          events.push("doctor");
          return audio.doctor(options);
        },
        startCapture: audio.startCapture.bind(audio),
        createPlayback: audio.createPlayback.bind(audio),
      },
      resolveConnection: async (options) => {
        events.push("resolve");
        resolvedOptions = options;
        return directConnection();
      },
      createChannel: () => {
        events.push("channel");
        const channel = new FakeChannel();
        channels.push(channel);
        return channel;
      },
    });

    await waitFor(() => stdin.isRaw, "raw terminal mode");
    expect(events.slice(0, 3)).toEqual(["resolve", "doctor", "channel"]);
    expect(resolvedOptions).toEqual({
      target: "Example Assistant",
      url: "http://127.0.0.1:7821",
      assistantId: "assistant-123",
      guardianToken: "guardian-secret",
    });
    expect(audio.doctorOptions).toEqual([
      { inputDevice: "input.node", outputDevice: "output.node" },
    ]);
    expect(audio.captureSessions).toHaveLength(0);
    expect(audio.playbackTargets).toEqual(["output.node"]);
    expect(channels[0].connectOptions).toEqual([
      {
        conversationId: "conversation-requested",
        turnDetection: "manual",
      },
    ]);

    stdin.emit("data", Buffer.from("q"));
    await running;
    expect(stdin.rawModes).toEqual([true, false]);
    expect(signalHost.listenerCount("SIGINT")).toBe(0);
    expect(signalHost.listenerCount("SIGTERM")).toBe(0);
    expect(signalHost.listenerCount("SIGHUP")).toBe(0);
  });

  test("doctor returns token-safe JSON readiness without opening capture", async () => {
    const stdout = new FakeOutput(false);
    const signalHost = new FakeSignalHost();
    const audio = new FakeAudio();
    const channels: FakeChannel[] = [];

    await voice({
      args: ["doctor", "assistant-123", "--json"],
      stdout,
      signalHost,
      audio,
      resolveConnection: async () => directConnection("never-print-me"),
      createChannel: () => {
        const channel = new FakeChannel();
        channels.push(channel);
        return channel;
      },
    });

    const result = JSON.parse(stdout.value) as {
      ok: boolean;
      target: {
        status: string;
        topology: string;
        assistantId: string;
      };
    };
    expect(result).toMatchObject({
      ok: true,
      target: {
        status: "ready",
        topology: "direct",
        assistantId: "assistant-123",
      },
    });
    expect(stdout.value).not.toContain("never-print-me");
    expect(audio.captureSessions).toHaveLength(0);
    expect(channels[0].requestEndCount).toBe(1);
    expect(channels[0].closeCount).toBe(1);
    expect(signalHost.exitCode).toBeUndefined();
  });

  test("doctor waits for server session release confirmation before returning", async () => {
    const stdout = new FakeOutput(false);
    const signalHost = new FakeSignalHost();
    const audio = new FakeAudio();
    const channel = new FakeChannel(
      "doctor-session",
      "doctor-conversation",
      false,
    );
    let completed = false;

    const running = voice({
      args: ["doctor", "assistant-123", "--json"],
      stdout,
      signalHost,
      audio,
      resolveConnection: async () => directConnection(),
      createChannel: () => channel,
    }).then(() => {
      completed = true;
    });

    await waitFor(
      () => channel.requestEndCount === 1,
      "the doctor end request",
    );
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(stdout.value).toBe("");
    expect(channel.closeCount).toBe(0);

    channel.emitSessionReleased();
    await running;

    expect(completed).toBe(true);
    expect(channel.closeCount).toBe(1);
    expect(JSON.parse(stdout.value)).toMatchObject({
      ok: true,
      target: { status: "ready" },
    });
  });

  test("uses stored Vellum login routing and refreshes the managed endpoint for each turn", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const signalHost = new FakeSignalHost();
    const audio = new FakeAudio();
    const channels: FakeChannel[] = [];
    const resolutionOptions: unknown[] = [];
    let tokenNumber = 0;

    const running = voice({
      args: ["assistant-managed"],
      stdin,
      stdout,
      signalHost,
      audio,
      resolveConnection: async (options) => {
        resolutionOptions.push(options);
        tokenNumber += 1;
        return {
          topology: "vellum-managed",
          assistantId: "assistant-managed",
          platformUrl: "https://app.example.com",
          webSocket: {
            url: `wss://voice.example.com/assistant-managed/v1/live-voice?token=token-${tokenNumber}`,
            logSafeUrl:
              "wss://voice.example.com/assistant-managed/v1/live-voice?token=%5BREDACTED%5D",
          },
        };
      },
      createChannel: () => {
        const channel = new FakeChannel(
          `session-${channels.length + 1}`,
          "conversation-managed",
        );
        channels.push(channel);
        return channel;
      },
    });

    await waitFor(() => stdin.isRaw);
    channels[0].emit("frame", {
      type: "utterance_discarded",
      seq: 2,
    });
    await waitFor(() => channels.length === 2, "managed endpoint refresh");
    expect(resolutionOptions).toEqual([
      { target: "assistant-managed" },
      { target: "assistant-managed" },
    ]);

    stdin.emit("data", Buffer.from("q"));
    await running;
  });

  test("restores the terminal and reaps capture on SSH loss", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const signalHost = new FakeSignalHost();
    const audio = new FakeAudio();

    const running = voice({
      args: ["assistant-123"],
      stdin,
      stdout,
      signalHost,
      audio,
      resolveConnection: async () => directConnection(),
      createChannel: () => new FakeChannel(),
    });

    await waitFor(() => stdin.isRaw);
    stdin.emit("data", Buffer.from("\r"));
    await waitFor(
      () => audio.captureSessions.length === 1,
      "microphone capture",
    );
    signalHost.emit("SIGHUP");
    await running;

    expect(audio.captureSessions[0].stopCount).toBe(1);
    expect(audio.playbackFlushCount).toBe(1);
    expect(audio.playbackCloseCount).toBe(1);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.pauseCount).toBe(1);
    expect(signalHost.exitCode).toBe(129);
    expect(signalHost.listenerCount("SIGHUP")).toBe(0);
  });
});

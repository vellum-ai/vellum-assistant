import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  EchoMeasurement,
  LIVE_VOICE_PCM_FRAME_BYTES,
  PcmFrameRechunker,
  pcm16Rms,
} from "../lib/live-voice/audio.js";
import {
  LIVE_VOICE_ECHO_CANCEL_SINK,
  LIVE_VOICE_ECHO_CANCEL_SOURCE,
  PipeWireAudio,
  buildPipeWirePcmArgs,
  parsePipeWireDevices,
  parsePipeWireEchoCancelPair,
  parsePipeWireVersion,
} from "../lib/live-voice/pipewire-audio.js";
import type {
  AudioCommandRunner,
  AudioProcessFactory,
  AudioProcessProbe,
} from "../lib/live-voice/pipewire-audio.js";

interface FakeProcessOptions {
  holdWrites?: boolean;
  closeOnStdinEnd?: boolean;
  ignoredSignals?: readonly NodeJS.Signals[];
}

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Buffer[] = [];
  readonly pendingWrites: Array<() => void> = [];
  readonly killSignals: NodeJS.Signals[] = [];
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private processClosed = false;
  private readonly ignoredSignals: ReadonlySet<NodeJS.Signals>;

  constructor(options: FakeProcessOptions = {}) {
    super();
    this.ignoredSignals = new Set(options.ignoredSignals);
    this.stdin = new Writable({
      highWaterMark: options.holdWrites ? 1 : 64 * 1024,
      write: (chunk: Buffer, _encoding, callback) => {
        this.writes.push(Buffer.from(chunk));
        if (options.holdWrites) {
          this.pendingWrites.push(callback);
        } else {
          callback();
        }
      },
    });
    if (options.closeOnStdinEnd ?? true) {
      this.stdin.once("finish", () => {
        queueMicrotask(() => {
          this.finish(0);
        });
      });
    }
  }

  releaseWrite(): void {
    this.pendingWrites.shift()?.();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.processClosed) {
      return false;
    }
    this.killed = true;
    this.killSignals.push(signal);
    if (this.ignoredSignals.has(signal)) {
      return true;
    }
    queueMicrotask(() => {
      this.finish(null, signal);
    });
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.processClosed) {
      return;
    }
    this.processClosed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function createProcessFactory(processOptions: FakeProcessOptions[] = []): {
  spawn: AudioProcessFactory;
  processes: FakeProcess[];
  calls: Array<{
    executable: string;
    args: readonly string[];
    shell: boolean | undefined;
  }>;
} {
  const processes: FakeProcess[] = [];
  const calls: Array<{
    executable: string;
    args: readonly string[];
    shell: boolean | undefined;
  }> = [];
  const spawn: AudioProcessFactory = (executable, args, options) => {
    calls.push({ executable, args: [...args], shell: options.shell });
    const child = new FakeProcess(processOptions[processes.length]);
    processes.push(child);
    return child.asChild();
  };
  return { spawn, processes, calls };
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const PIPEWIRE_DUMP = JSON.stringify([
  {
    id: 31,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "object.serial": 1001,
        "node.name": "capture.node",
        "node.description": "USB Microphone",
        "media.class": "Audio/Source",
        "module.id": 8,
      },
    },
  },
  {
    id: 32,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "object.serial": "1002",
        "node.name": "playback.node",
        "node.nick": "USB Speaker",
        "media.class": "Audio/Sink",
        "module.id": 8,
      },
    },
  },
  {
    id: 33,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "object.serial": 1003,
        "node.name": "video.node",
        "media.class": "Video/Source",
      },
    },
  },
]);

function echoCancelDump(
  options: {
    sourceModuleId?: number;
    sinkModuleId?: number | string;
    moduleName?: string;
    sourceName?: string;
    sinkName?: string;
    sourceMediaClass?: string;
    sinkMediaClass?: string;
  } = {},
): string {
  const sourceModuleId = options.sourceModuleId ?? 41;
  const sinkModuleId = options.sinkModuleId ?? sourceModuleId;
  return JSON.stringify([
    {
      id: 41,
      type: "PipeWire:Interface:Module",
      info: {
        props: {
          "module.name": options.moduleName ?? "libpipewire-module-echo-cancel",
        },
      },
    },
    {
      id: 51,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "object.serial": 2001,
          "node.name": options.sourceName ?? LIVE_VOICE_ECHO_CANCEL_SOURCE,
          "node.description": "Echo-cancel capture",
          "media.class": options.sourceMediaClass ?? "Audio/Source",
          "module.id": sourceModuleId,
        },
      },
    },
    {
      id: 52,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "object.serial": 2002,
          "node.name": options.sinkName ?? LIVE_VOICE_ECHO_CANCEL_SINK,
          "node.description": "Echo-cancel playback",
          "media.class": options.sinkMediaClass ?? "Audio/Sink",
          "module.id": sinkModuleId,
        },
      },
    },
  ]);
}

describe("PCM framing", () => {
  test("uses exact 50 ms PCM16 frames and preserves odd chunk boundaries", () => {
    expect(LIVE_VOICE_PCM_FRAME_BYTES).toBe(1_600);
    const source = Buffer.alloc(1_701);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    const framer = new PcmFrameRechunker();

    expect(framer.push(source.subarray(0, 1))).toEqual([]);
    const frames = framer.push(source.subarray(1, 1_600));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(source.subarray(0, 1_600));
    expect(framer.push(source.subarray(1_600))).toEqual([]);

    const tail = framer.flush();
    expect(tail).toEqual(source.subarray(1_600, 1_700));
    expect(framer.flush()).toBeNull();
  });

  test("generates equal-size zero frames and an aligned muted tail", () => {
    const framer = new PcmFrameRechunker();
    const frames = framer.push(Buffer.alloc(1_600, 0x7f), true);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.alloc(1_600));

    framer.push(Buffer.alloc(5, 0x7f));
    expect(framer.flush(true)).toEqual(Buffer.alloc(4));
  });

  test("measures PCM16 RMS without retaining audio", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16_384, 0);
    pcm.writeInt16LE(-16_384, 2);
    expect(pcm16Rms(pcm)).toBeCloseTo(0.5, 8);
    expect(pcm16Rms(Buffer.alloc(0))).toBe(0);
  });
});

describe("PipeWire device discovery and capture", () => {
  test("accepts only the exact pair owned by one echo-cancel module", () => {
    expect(parsePipeWireEchoCancelPair(echoCancelDump())).toMatchObject({
      input: { nodeName: LIVE_VOICE_ECHO_CANCEL_SOURCE },
      output: { nodeName: LIVE_VOICE_ECHO_CANCEL_SINK },
      moduleId: 41,
    });
    expect(
      parsePipeWireEchoCancelPair(echoCancelDump({ sinkModuleId: "41" })),
    ).toMatchObject({ moduleId: 41 });
    expect(
      parsePipeWireEchoCancelPair(echoCancelDump({ sinkModuleId: 42 })),
    ).toBeNull();
    expect(
      parsePipeWireEchoCancelPair(
        echoCancelDump({ moduleName: "libpipewire-module-loopback" }),
      ),
    ).toBeNull();
    expect(
      parsePipeWireEchoCancelPair(
        echoCancelDump({ sourceMediaClass: "Audio/Source/Virtual" }),
      ),
    ).toBeNull();
  });

  test("does not accept descriptive echo or headset labels as AEC proof", () => {
    expect(
      parsePipeWireEchoCancelPair(
        echoCancelDump({
          sourceName: "echo-cancel-headset-source",
          sinkName: "echo-cancel-headset-sink",
        }),
      ),
    ).toBeNull();
  });

  test("preserves stable node names, serials, classes, and module ownership", () => {
    const devices = parsePipeWireDevices(PIPEWIRE_DUMP);
    expect(devices).toEqual({
      inputs: [
        {
          direction: "input",
          nodeName: "capture.node",
          objectSerial: "1001",
          description: "USB Microphone",
          mediaClass: "Audio/Source",
          objectId: 31,
          moduleId: 8,
        },
      ],
      outputs: [
        {
          direction: "output",
          nodeName: "playback.node",
          objectSerial: "1002",
          description: "USB Speaker",
          mediaClass: "Audio/Sink",
          objectId: 32,
          moduleId: 8,
        },
      ],
    });
  });

  test("rejects malformed pw-dump payloads", () => {
    expect(() => parsePipeWireDevices("{")).toThrow(
      "pw-dump returned invalid JSON",
    );
    expect(() => parsePipeWireDevices("{}")).toThrow(
      "pw-dump returned an unexpected payload",
    );
  });

  test("passes a selected target as one argument without a shell", async () => {
    const factory = createProcessFactory();
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const frames: Buffer[] = [];
    const target = "capture.node; touch /tmp/example";
    const capture = await audio.startCapture({
      target,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });

    expect(factory.calls[0]).toEqual({
      executable: "/usr/bin/pw-record",
      args: [
        "--raw",
        "--rate=16000",
        "--channels=1",
        "--format=s16",
        "--latency=50ms",
        `--target=${target}`,
        "-",
      ],
      shell: false,
    });

    factory.processes[0].stdout.write(Buffer.alloc(1));
    factory.processes[0].stdout.write(Buffer.alloc(1_599, 1));
    await nextEventLoop();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(1_600);

    const firstStop = capture.stop();
    const secondStop = capture.stop();
    expect(firstStop).toBe(secondStop);
    expect(await firstStop).toBeNull();
    expect(factory.processes[0].killSignals).toEqual(["SIGTERM"]);
  });

  test("flushes an aligned capture tail and reports child failure", async () => {
    const factory = createProcessFactory();
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const capture = await audio.startCapture({ onFrame: () => {} });
    factory.processes[0].stdout.write(Buffer.from([1, 2, 3, 4, 5]));
    await nextEventLoop();

    expect(await capture.stop()).toEqual(Buffer.from([1, 2, 3, 4]));

    const failedCapture = await audio.startCapture({ onFrame: () => {} });
    factory.processes[1].finish(2);
    await expect(failedCapture.closed).rejects.toThrow(
      "pw-record stopped unexpectedly with code 2",
    );
  });

  test("reports an unsolicited clean capture exit", async () => {
    const factory = createProcessFactory();
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const capture = await audio.startCapture({ onFrame: () => {} });

    factory.processes[0].finish(0);

    await expect(capture.closed).rejects.toThrow(
      "pw-record stopped unexpectedly with code 0",
    );
  });

  test("bounds capture shutdown when the process ignores termination", async () => {
    const factory = createProcessFactory([
      { ignoredSignals: ["SIGTERM", "SIGKILL"] },
    ]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
      processTerminationGraceMs: 1,
      processForceKillGraceMs: 1,
    });
    const capture = await audio.startCapture({ onFrame: () => {} });

    const firstStop = capture.stop();
    const secondStop = capture.stop();

    expect(firstStop).toBe(secondStop);
    expect(await firstStop).toBeNull();
    expect(factory.processes[0].killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("builds the protocol capture cadence without an explicit target", () => {
    expect(buildPipeWirePcmArgs()).toEqual([
      "--raw",
      "--rate=16000",
      "--channels=1",
      "--format=s16",
      "--latency=50ms",
      "-",
    ]);
  });
});

describe("PipeWire playback", () => {
  test("serializes writes and waits for stdin backpressure", async () => {
    const factory = createProcessFactory([{ holdWrites: true }]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const playback = audio.createPlayback("playback.node");

    const first = playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    const second = playback.write({
      audio: Buffer.from([3, 4]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    await nextEventLoop();

    expect(factory.processes[0].writes).toEqual([Buffer.from([1, 2])]);
    factory.processes[0].releaseWrite();
    await first;
    await nextEventLoop();
    expect(factory.processes[0].writes).toEqual([
      Buffer.from([1, 2]),
      Buffer.from([3, 4]),
    ]);
    factory.processes[0].releaseWrite();
    await second;

    const drained = playback.drain();
    await nextEventLoop();
    await drained;
    expect(factory.calls[0].args).toContain("--target=playback.node");
  });

  test("restarts lazily when the sample rate changes", async () => {
    const factory = createProcessFactory();
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const playback = audio.createPlayback();

    await playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    await playback.write({
      audio: Buffer.from([3, 4]),
      mimeType: "audio/pcm",
      sampleRate: 24_000,
    });

    expect(factory.processes).toHaveLength(2);
    expect(factory.processes[0].killSignals).toEqual(["SIGTERM"]);
    expect(factory.calls[0].args).toContain("--rate=16000");
    expect(factory.calls[1].args).toContain("--rate=24000");
    await playback.close();
  });

  test("flushes immediately, drops buffered writes, and recreates playback", async () => {
    const factory = createProcessFactory([{ holdWrites: true }, {}]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const target = "playback.node; touch /tmp/example";
    const playback = audio.createPlayback(target);

    const buffered = playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    const queued = playback.write({
      audio: Buffer.from([3, 4]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    await nextEventLoop();
    const flushed = playback.flush();
    expect(factory.processes[0].killSignals).toEqual(["SIGTERM"]);
    await Promise.all([buffered, queued, flushed]);

    await playback.write({
      audio: Buffer.from([9, 10]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    expect(factory.processes).toHaveLength(2);
    expect(factory.processes[1].writes).toEqual([Buffer.from([9, 10])]);
    expect(factory.calls[1].args).toContain(`--target=${target}`);
    expect(factory.calls[1].shell).toBe(false);
    await playback.close();
    await playback.close();
    expect(factory.processes[1].killSignals).toEqual(["SIGTERM"]);
  });

  test("escalates playback shutdown and bounds the final reap wait", async () => {
    const factory = createProcessFactory([
      { ignoredSignals: ["SIGTERM", "SIGKILL"] },
    ]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
      processTerminationGraceMs: 1,
      processForceKillGraceMs: 1,
    });
    const playback = audio.createPlayback();
    await playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });

    const firstClose = playback.close();
    const secondClose = playback.close();

    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toThrow(
      "pw-play did not exit after SIGKILL",
    );
    expect(factory.processes[0].killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("bounds playback drain when stdin closure does not stop the process", async () => {
    const factory = createProcessFactory([
      {
        closeOnStdinEnd: false,
        ignoredSignals: ["SIGKILL"],
      },
    ]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
      processForceKillGraceMs: 1,
      playbackDrainGraceMs: 1,
    });
    const playback = audio.createPlayback();
    await playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });

    await expect(playback.drain()).rejects.toThrow(
      "pw-play did not exit after SIGKILL",
    );
    expect(factory.processes[0].killSignals).toEqual(["SIGKILL"]);
    await playback.close();
  });

  test("rejects unsupported provider output with format details", async () => {
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const playback = audio.createPlayback();
    await expect(
      playback.write({
        audio: Buffer.from([1]),
        mimeType: "audio/mpeg",
        sampleRate: 24_000,
        provider: "Example TTS",
      }),
    ).rejects.toThrow(
      "Example TTS returned unsupported live voice audio audio/mpeg at 24000 Hz. Expected audio/pcm.",
    );
  });

  test("surfaces an unexpected child failure", async () => {
    const factory = createProcessFactory([{ holdWrites: true }]);
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const playback = audio.createPlayback();
    const write = playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    await nextEventLoop();
    factory.processes[0].finish(1);
    await expect(write).rejects.toThrow(
      "pw-play stopped while audio was buffered",
    );
  });

  test("does not silently replace a failed playback process", async () => {
    const factory = createProcessFactory();
    const audio = new PipeWireAudio({
      spawnProcess: factory.spawn,
      findExecutable: async (name) => `/usr/bin/${name}`,
    });
    const playback = audio.createPlayback();
    await playback.write({
      audio: Buffer.from([1, 2]),
      mimeType: "audio/pcm",
      sampleRate: 16_000,
    });
    factory.processes[0].finish(7);

    await expect(
      playback.write({
        audio: Buffer.from([3, 4]),
        mimeType: "audio/pcm",
        sampleRate: 16_000,
      }),
    ).rejects.toThrow("pw-play stopped unexpectedly with code 7");
    expect(factory.processes).toHaveLength(1);
  });
});

describe("PipeWire doctor", () => {
  test("routes open-mic probes through the verified exact pair", async () => {
    const probeTargets: string[][] = [];
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.4.2", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=yes", stderr: "" };
      }
      return { code: 0, stdout: echoCancelDump(), stderr: "" };
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess: async (_executable, args) => {
        probeTargets.push([...args]);
        return { ok: true };
      },
      platform: "linux",
      architecture: "arm64",
      username: "user1",
    });

    const report = await audio.doctor({ mode: "open-mic" });

    expect(report.ok).toBe(true);
    expect(report.echoCancelPair?.moduleId).toBe(41);
    expect(probeTargets[0]).toContain(
      `--target=${LIVE_VOICE_ECHO_CANCEL_SOURCE}`,
    );
    expect(probeTargets[1]).toContain(
      `--target=${LIVE_VOICE_ECHO_CANCEL_SINK}`,
    );
  });

  test("fails open-mic diagnostics for mismatched module ownership", async () => {
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.4.2", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=yes", stderr: "" };
      }
      return {
        code: 0,
        stdout: echoCancelDump({ sinkModuleId: 42 }),
        stderr: "",
      };
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess: async () => ({ ok: true }),
      platform: "linux",
      architecture: "arm64",
      username: "user1",
    });

    const report = await audio.doctor({ mode: "open-mic" });

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "aec.module"),
    ).toMatchObject({
      status: "fail",
    });
    expect(
      report.checks.find((check) => check.id === "aec.module")?.message,
    ).toContain("--mode push-to-talk");
  });

  test("parses PipeWire versions", () => {
    expect(parsePipeWireVersion("Compiled with libpipewire 1.4.2")).toEqual({
      major: 1,
      minor: 4,
      patch: 2,
    });
    expect(parsePipeWireVersion("pw-record 0.3")).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
    });
    expect(parsePipeWireVersion("unknown")).toBeNull();
  });

  test("distinguishes a missing user session from missing hardware", async () => {
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.4.2", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 3, stdout: "inactive", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=no\n", stderr: "" };
      }
      if (args.length === 0) {
        return { code: 0, stdout: PIPEWIRE_DUMP, stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess: async () => ({ ok: true }),
      platform: "linux",
      architecture: "arm64",
      username: "user1",
      runtimeDirectory: "/run/user/1000",
      pathExists: () => false,
    });

    const report = await audio.doctor();
    expect(
      report.checks.find((check) => check.id === "session.pipewire"),
    ).toMatchObject({ status: "fail" });
    expect(
      report.checks.find((check) => check.id === "session.wireplumber"),
    ).toMatchObject({ status: "fail" });
    expect(
      report.checks.find((check) => check.id === "session.linger"),
    ).toMatchObject({ status: "fail" });
    expect(
      report.checks.find((check) => check.id === "devices.input"),
    ).toMatchObject({ status: "skip" });
    expect(
      report.checks.find((check) => check.id === "probe.input"),
    ).toMatchObject({ status: "skip" });
  });

  test("reports missing hardware separately when the user session is active", async () => {
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.4.0", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active\n", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess: async () => ({ ok: true }),
      platform: "linux",
      architecture: "arm64",
      username: "user1",
    });

    const report = await audio.doctor();
    expect(
      report.checks.find((check) => check.id === "session.pipewire"),
    ).toMatchObject({ status: "pass" });
    expect(
      report.checks.find((check) => check.id === "devices.input"),
    ).toMatchObject({ status: "fail" });
    expect(
      report.checks.find((check) => check.id === "devices.output"),
    ).toMatchObject({ status: "fail" });
  });

  test("validates explicit devices and runs in-memory process probes", async () => {
    const probeCalls: Array<{
      executable: string;
      args: readonly string[];
      input?: Buffer;
      requireOutput?: boolean;
    }> = [];
    const probeProcess: AudioProcessProbe = async (
      executable,
      args,
      options,
    ) => {
      probeCalls.push({
        executable,
        args: [...args],
        input: options.input,
        requireOutput: options.requireOutput,
      });
      return { ok: true };
    };
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.4.1", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=yes", stderr: "" };
      }
      return { code: 0, stdout: PIPEWIRE_DUMP, stderr: "" };
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess,
      platform: "linux",
      architecture: "arm64",
      username: "user1",
    });

    const report = await audio.doctor({
      inputDevice: "1001",
      outputDevice: "playback.node",
    });
    expect(report.ok).toBe(true);
    expect(
      report.checks.find((check) => check.id === "device.input.selected"),
    ).toMatchObject({ status: "pass" });
    expect(probeCalls).toHaveLength(2);
    expect(probeCalls[0].args).toContain("--target=capture.node");
    expect(probeCalls[0].requireOutput).toBe(true);
    expect(probeCalls[1].args).toContain("--target=playback.node");
    expect(probeCalls[1].input).toEqual(Buffer.alloc(1_600));
  });

  test("rejects PipeWire older than 1.4 and an invalid explicit device", async () => {
    const runCommand: AudioCommandRunner = async (_executable, args) => {
      if (args.includes("--version")) {
        return { code: 0, stdout: "pw-record 1.3.9", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: 0, stdout: "active", stderr: "" };
      }
      if (args.includes("show-user")) {
        return { code: 0, stdout: "Linger=yes", stderr: "" };
      }
      return { code: 0, stdout: PIPEWIRE_DUMP, stderr: "" };
    };
    const audio = new PipeWireAudio({
      findExecutable: async (name) => `/usr/bin/${name}`,
      runCommand,
      probeProcess: async () => ({ ok: true }),
      platform: "linux",
      architecture: "arm64",
      username: "user1",
    });

    const report = await audio.doctor({ inputDevice: "missing.node" });
    expect(
      report.checks.find((check) => check.id === "pipewire.version"),
    ).toMatchObject({ status: "fail" });
    expect(
      report.checks.find((check) => check.id === "device.input.selected"),
    ).toMatchObject({ status: "fail" });
  });
});

describe("echo measurements", () => {
  test("reports scalar floor, margin, peak, and correlation after silence", () => {
    const measurement = new EchoMeasurement();
    expect(measurement.addSample({ microphone: 0.1, playback: 0 })).toBeNull();
    expect(measurement.addSample({ microphone: 0.1, playback: 0 })).toBeNull();
    expect(
      measurement.addSample({ microphone: 0.2, playback: 0.2 }),
    ).toBeNull();
    expect(
      measurement.addSample({ microphone: 0.4, playback: 0.4 }),
    ).toBeNull();
    expect(
      measurement.addSample({ microphone: 0.6, playback: 0.6 }),
    ).toBeNull();

    const summary = measurement.addSample({
      microphone: 0.1,
      playback: 0,
    });
    expect(summary).not.toBeNull();
    expect(summary?.sampleCount).toBe(3);
    expect(summary?.microphoneFloor).toBeCloseTo(0.1, 8);
    expect(summary?.meanMicrophoneDuringPlayback).toBeCloseTo(0.4, 8);
    expect(summary?.peakMicrophoneDuringPlayback).toBeCloseTo(0.6, 8);
    expect(summary?.decibelsAboveFloor).toBeCloseTo(20 * Math.log10(4), 8);
    expect(summary?.playbackMicrophoneCorrelation).toBeCloseTo(1, 8);
    expect(measurement.addSample({ microphone: 0.1, playback: 0 })).toBeNull();
    expect(
      Object.values(measurement).some(
        (value) => Buffer.isBuffer(value) || Array.isArray(value),
      ),
    ).toBe(false);
  });

  test("emits once per utterance and resets scalar accumulators", () => {
    const measurement = new EchoMeasurement();
    measurement.addSample({ microphone: 0.01, playback: 0 });
    measurement.addSample({ microphone: 0.2, playback: 0.5 });
    const first = measurement.addSample({ microphone: 0.02, playback: 0 });
    expect(first?.sampleCount).toBe(1);
    expect(measurement.addSample({ microphone: 0.03, playback: 0 })).toBeNull();

    measurement.addSample({ microphone: 0.3, playback: 0.2 });
    measurement.addSample({ microphone: 0.1, playback: 0.4 });
    const second = measurement.addSample({
      microphone: 0.02,
      playback: 0,
    });
    expect(second?.sampleCount).toBe(2);
    expect(second?.peakMicrophoneDuringPlayback).toBeCloseTo(0.3, 8);
    expect(second?.playbackMicrophoneCorrelation).toBeCloseTo(-1, 8);
  });
});

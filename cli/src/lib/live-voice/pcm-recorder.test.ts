import { describe, expect, test } from "bun:test";

import { PcmRecorder, recorderInstallHint } from "./pcm-recorder.js";
import type { RecorderCommand } from "./pcm-recorder.js";

/** A recorder that emits a known PCM pattern, so chunks can be identified. */
const emitter = (bytes: number, delaySeconds = 0): RecorderCommand => ({
  name: "/bin/sh",
  provides: "test",
  args: () => ["-c", `sleep ${delaySeconds}; head -c ${bytes} /dev/zero`],
});

/** A recorder that runs but never emits, like a denied microphone permission. */
const mute = (): RecorderCommand => ({
  name: "/bin/sh",
  provides: "test",
  args: () => ["-c", "sleep 30"],
});

describe("PcmRecorder", () => {
  test("streams captured bytes to the chunk callback", async () => {
    const recorder = new PcmRecorder(emitter(4096));
    const chunks: Buffer[] = [];
    const started = recorder.start(
      (pcm) => chunks.push(pcm),
      () => {},
    );

    expect(started).toBe(true);
    await Bun.sleep(400);
    expect(Buffer.concat(chunks).length).toBe(4096);
    expect(recorder.hasCapturedAudio).toBe(true);
    recorder.stop();
  });

  test("reports a recorder that exits on its own", async () => {
    const recorder = new PcmRecorder(emitter(16));
    const failures: string[] = [];
    recorder.start(
      () => {},
      (reason) => failures.push(reason),
    );

    await Bun.sleep(400);
    // An exit is not retried: the usual causes (no input device, denied
    // permission) are conditions the user has to fix, and a respawn loop would
    // hide them behind an apparently-live session.
    expect(failures).toHaveLength(1);
    expect(recorder.isRecording).toBe(false);
    recorder.stop();
  });

  test("a deliberate stop is not reported as a failure", async () => {
    const recorder = new PcmRecorder(emitter(4096, 5));
    const failures: string[] = [];
    recorder.start(
      () => {},
      (reason) => failures.push(reason),
    );

    recorder.stop();
    await Bun.sleep(300);

    expect(failures).toEqual([]);
    expect(recorder.isRecording).toBe(false);
  });

  test("start() is a no-op while already recording", () => {
    const recorder = new PcmRecorder(emitter(4096, 5));
    expect(
      recorder.start(
        () => {},
        () => {},
      ),
    ).toBe(true);
    expect(
      recorder.start(
        () => {},
        () => {},
      ),
    ).toBe(false);
    recorder.stop();
  });

  test("with no recorder installed, start() does nothing", () => {
    const recorder = new PcmRecorder(null);
    expect(
      recorder.start(
        () => {},
        () => {},
      ),
    ).toBe(false);
    expect(recorder.recorderName).toBeNull();
  });
});

describe("recorderInstallHint", () => {
  test("names every package the ladder can use", () => {
    const hint = recorderInstallHint();
    expect(hint).toContain("alsa-utils");
    expect(hint).toContain("sox");
    expect(hint).toContain("ffmpeg");
  });
});

describe("silent microphone", () => {
  test("a recorder that runs but never emits is reported, not left live", async () => {
    // The shape of a denied or still-pending microphone permission: the
    // process starts fine and stdout simply stays empty, so nothing reaches
    // the exit handler and the session would otherwise look healthy.
    const recorder = new PcmRecorder(mute(), 150);
    const failures: string[] = [];
    recorder.start(
      () => {},
      (reason) => failures.push(reason),
    );

    await Bun.sleep(500);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no audio");
    expect(failures[0]).toContain("microphone");
    expect(recorder.isRecording).toBe(false);
    recorder.stop();
  });

  test("audio arriving in time cancels the deadline", async () => {
    const recorder = new PcmRecorder(emitter(2048, 0), 150);
    const failures: string[] = [];
    recorder.start(
      () => {},
      (reason) => failures.push(reason),
    );

    await Bun.sleep(120);
    expect(recorder.hasCapturedAudio).toBe(true);
    // The process exits after emitting, which is its own reported failure;
    // what must not appear is the silence one.
    expect(failures.filter((f) => f.includes("no audio"))).toEqual([]);
    recorder.stop();
  });
});

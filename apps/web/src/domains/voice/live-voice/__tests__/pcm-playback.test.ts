import { describe, expect, it, mock } from "bun:test";

import {
    LiveVoicePcmPlayback,
    type AudioBufferLike,
    type AudioBufferSourceNodeLike,
    type AudioDestinationNodeLike,
    type PcmAudioContextLike,
} from "@/domains/voice/live-voice/pcm-playback";

interface ScheduledNode {
    node: AudioBufferSourceNodeLike;
    startedAt: number | undefined;
    stoppedAt: number | undefined;
    buffer: AudioBufferLike | null;
}

class MockAudioBuffer implements AudioBufferLike {
    readonly duration: number;
    private readonly channels: Float32Array[];

    constructor(channelCount: number, frameCount: number, sampleRate: number) {
        this.duration = frameCount / sampleRate;
        this.channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
    }

    getChannelData(channel: number): Float32Array {
        const data = this.channels[channel];
        if (!data) throw new Error(`channel ${channel} out of range`);
        return data;
    }

    copyToChannel(source: Float32Array, channel: number): void {
        this.getChannelData(channel).set(source);
    }
}

class MockAudioContext implements PcmAudioContextLike {
    currentTime = 0;
    readonly destination: AudioDestinationNodeLike = {};
    readonly scheduled: ScheduledNode[] = [];

    createBuffer(channels: number, frameCount: number, sampleRate: number): AudioBufferLike {
        return new MockAudioBuffer(channels, frameCount, sampleRate);
    }

    createBufferSource(): AudioBufferSourceNodeLike {
        const tracked: ScheduledNode = {
            node: undefined as unknown as AudioBufferSourceNodeLike,
            startedAt: undefined,
            stoppedAt: undefined,
            buffer: null,
        };
        const node: AudioBufferSourceNodeLike = {
            buffer: null,
            onended: null,
            connect: () => {},
            start: (when?: number) => {
                tracked.startedAt = when;
                tracked.buffer = node.buffer;
            },
            stop: (when?: number) => {
                tracked.stoppedAt = when;
            },
        };
        tracked.node = node;
        this.scheduled.push(tracked);
        return node;
    }

    advanceTo(seconds: number): void {
        this.currentTime = seconds;
    }
}

function pcmChunk(samples: number[], sampleRate = 24000, channels = 1) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) {
        view.setInt16(i * 2, samples[i] ?? 0, true);
    }
    return {
        pcm: bytes,
        mimeType: "audio/pcm",
        sampleRate,
        channels,
    };
}

describe("LiveVoicePcmPlayback", () => {
    it("schedules consecutive PCM chunks back-to-back without gaps", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        const samplesA = new Array(2400).fill(100); // 0.1s @ 24kHz
        const samplesB = new Array(4800).fill(200); // 0.2s @ 24kHz
        playback.enqueueTtsAudio(pcmChunk(samplesA));
        playback.enqueueTtsAudio(pcmChunk(samplesB));

        expect(ctx.scheduled).toHaveLength(2);
        const first = ctx.scheduled[0];
        const second = ctx.scheduled[1];
        expect(first?.startedAt).toBe(0);
        expect(first?.buffer?.duration).toBeCloseTo(0.1, 5);
        // Second start time must equal the first's end time — gapless.
        expect(second?.startedAt).toBeCloseTo(0.1, 5);
        expect(second?.buffer?.duration).toBeCloseTo(0.2, 5);
    });

    it("handleInterrupt() stops all scheduled nodes and resets the cursor", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        expect(playback.isPlaying).toBe(true);

        playback.handleInterrupt();

        for (const entry of ctx.scheduled) {
            expect(entry.stoppedAt).toBe(0);
        }

        // Cursor reset — current time is still 0, so isPlaying is false.
        expect(playback.isPlaying).toBe(false);

        // After interrupt, a fresh enqueue starts at currentTime (0), not
        // accumulated on top of the prior cursor.
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        const fresh = ctx.scheduled[ctx.scheduled.length - 1];
        expect(fresh?.startedAt).toBe(0);
    });

    it("waitUntilPlaybackFinishes() resolves only after the cursor is reached", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        // 0.05s @ 24kHz = 1200 samples
        playback.enqueueTtsAudio(pcmChunk(new Array(1200).fill(0)));

        let resolved = false;
        const wait = playback.waitUntilPlaybackFinishes().then(() => {
            resolved = true;
        });

        // Synchronously, the promise hasn't resolved yet.
        await Promise.resolve();
        expect(resolved).toBe(false);

        // Advance the mock clock past the cursor; the scheduled setTimeout
        // (50ms) will fire after that real-time delay.
        ctx.advanceTo(0.05);
        await wait;
        expect(resolved).toBe(true);
        expect(playback.isPlaying).toBe(false);
    });

    it("waitUntilPlaybackFinishes() resolves immediately when no audio is queued", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        // Never called the factory — should resolve without scheduling work.
        await playback.waitUntilPlaybackFinishes();

        playback.enqueueTtsAudio(pcmChunk(new Array(1200).fill(0)));
        ctx.advanceTo(1);
        // After advancing past the cursor, the promise resolves synchronously.
        await playback.waitUntilPlaybackFinishes();
        expect(playback.isPlaying).toBe(false);
    });

    it("drops non-PCM chunks with a warning and does not throw", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        expect(() => {
            playback.enqueueTtsAudio({
                pcm: new Uint8Array([0xff, 0xfb, 0x00, 0x00]),
                mimeType: "audio/mpeg",
                sampleRate: 24000,
                channels: 1,
            });
        }).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx.scheduled).toHaveLength(0);
    });

    it("drops PCM chunks whose byte length isn't aligned to Int16", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x01, 0x02, 0x03]), // odd length
            mimeType: "audio/pcm",
            sampleRate: 24000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx.scheduled).toHaveLength(0);
    });

    it("decodes PCM16 LE samples to normalized Float32 values", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        // -32768, 0, 32767 — covers min, mid, near-max
        const chunk = pcmChunk([-32768, 0, 32767]);
        playback.enqueueTtsAudio(chunk);

        const buffer = ctx.scheduled[0]?.buffer;
        expect(buffer).not.toBeNull();
        const data = buffer!.getChannelData(0);
        expect(data[0]).toBeCloseTo(-1, 5);
        expect(data[1]).toBe(0);
        expect(data[2]).toBeCloseTo(32767 / 32768, 5);
    });

    it("resetForNextResponse() is a no-op for scheduling (cursor preserved)", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0))); // 0.1s
        playback.resetForNextResponse();
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));

        const first = ctx.scheduled[0];
        const second = ctx.scheduled[1];
        expect(first?.startedAt).toBe(0);
        // Cursor still in effect — second chunk schedules after the first.
        expect(second?.startedAt).toBeCloseTo(0.1, 5);
    });

    it("handleSessionError() stops scheduled nodes like an interrupt", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleSessionError();

        for (const entry of ctx.scheduled) {
            expect(entry.stoppedAt).toBe(0);
        }
        expect(playback.isPlaying).toBe(false);
    });

    it("handleEnd() lets the scheduled tail drain without stopping nodes", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleEnd();

        for (const entry of ctx.scheduled) {
            expect(entry.stoppedAt).toBeUndefined();
        }
        expect(playback.isPlaying).toBe(true);
    });
});

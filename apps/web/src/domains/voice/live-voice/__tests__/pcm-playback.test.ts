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

        // After interrupt + reset, a fresh enqueue starts at currentTime (0),
        // not accumulated on top of the prior cursor.
        playback.resetForNextResponse();
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

    it("resetForNextResponse() preserves the cursor between back-to-back responses", () => {
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

    it("handleSessionError() drops late TTS chunks until resetForNextResponse()", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleSessionError();

        const scheduledCount = ctx.scheduled.length;
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        // No new node was scheduled — `acceptsAudio` gate dropped the chunk.
        expect(ctx.scheduled).toHaveLength(scheduledCount);
    });

    it("handleEnd() stops scheduled nodes and resets the cursor", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleEnd();

        for (const entry of ctx.scheduled) {
            expect(entry.stoppedAt).toBe(0);
        }
        expect(playback.isPlaying).toBe(false);
    });

    it("handleInterrupt() drops late TTS chunks until resetForNextResponse()", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleInterrupt();

        const scheduledCount = ctx.scheduled.length;
        // A delayed TTS chunk arriving after the interrupt must be dropped —
        // mirrors `LiveVoiceAudioPlayer.stop(reason: .interrupt)` behaviour.
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        expect(ctx.scheduled).toHaveLength(scheduledCount);
    });

    it("handleEnd() drops subsequent TTS chunks until resetForNextResponse()", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleEnd();

        const scheduledCount = ctx.scheduled.length;
        // Once the user ends the live voice session, TTS must not resume —
        // any chunks that race the session-end must be dropped.
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        expect(ctx.scheduled).toHaveLength(scheduledCount);
    });

    it("resetForNextResponse() re-enables enqueue after an interrupt", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleInterrupt();

        const beforeReset = ctx.scheduled.length;
        // Sanity: gate is closed after the interrupt.
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        expect(ctx.scheduled).toHaveLength(beforeReset);

        playback.resetForNextResponse();
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        // After reset, the next assistant turn can play again.
        expect(ctx.scheduled).toHaveLength(beforeReset + 1);
        const fresh = ctx.scheduled[ctx.scheduled.length - 1];
        expect(fresh?.startedAt).toBe(0);
    });

    it("handleInterrupt() resolves a pending waitUntilPlaybackFinishes() promise without waiting for the original cursor", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        // 0.5s @ 24kHz = 12000 samples — long enough that a real setTimeout
        // would visibly stall the test if the waiter weren't resolved early.
        playback.enqueueTtsAudio(pcmChunk(new Array(12000).fill(0)));

        let resolved = false;
        const wait = playback.waitUntilPlaybackFinishes().then(() => {
            resolved = true;
        });

        // Synchronously, the waiter hasn't fired.
        await Promise.resolve();
        expect(resolved).toBe(false);

        // Interrupt before the cursor (0.5s) is reached. The waiter should
        // resolve promptly rather than waiting for the original duration.
        playback.handleInterrupt();
        await wait;
        expect(resolved).toBe(true);
        expect(playback.isPlaying).toBe(false);
    });

    it("handleEnd() resolves a pending waitUntilPlaybackFinishes() promise without waiting for the original cursor", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(12000).fill(0))); // 0.5s

        let resolved = false;
        const wait = playback.waitUntilPlaybackFinishes().then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).toBe(false);

        playback.handleEnd();
        await wait;
        expect(resolved).toBe(true);
        expect(playback.isPlaying).toBe(false);
    });

    it("handleSessionError() resolves a pending waitUntilPlaybackFinishes() promise", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(12000).fill(0))); // 0.5s

        let resolved = false;
        const wait = playback.waitUntilPlaybackFinishes().then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).toBe(false);

        playback.handleSessionError();
        await wait;
        expect(resolved).toBe(true);
    });

    it("resetForNextResponse() re-enables enqueue after handleEnd", () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        playback.handleEnd();
        playback.resetForNextResponse();

        const beforeEnqueue = ctx.scheduled.length;
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0)));
        expect(ctx.scheduled).toHaveLength(beforeEnqueue + 1);
    });

    it("accepts audio/pcm with no parameters", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/pcm",
            sampleRate: 24000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(0);
        expect(ctx.scheduled).toHaveLength(1);
    });

    it("accepts audio/pcm with parameters", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/pcm;rate=16000",
            sampleRate: 16000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(0);
        expect(ctx.scheduled).toHaveLength(1);
    });

    it("accepts audio/PCM case-insensitively", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/PCM",
            sampleRate: 24000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(0);
        expect(ctx.scheduled).toHaveLength(1);
    });

    it("rejects audio/pcma (G.711 A-law)", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/pcma",
            sampleRate: 8000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx.scheduled).toHaveLength(0);
    });

    it("rejects audio/pcmu (G.711 mu-law)", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/pcmu",
            sampleRate: 8000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx.scheduled).toHaveLength(0);
    });

    it("rejects audio/wav", () => {
        const ctx = new MockAudioContext();
        const warn = mock(() => {});
        const playback = new LiveVoicePcmPlayback({
            audioContextFactory: () => ctx,
            logger: { warn },
        });

        playback.enqueueTtsAudio({
            pcm: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
            mimeType: "audio/wav",
            sampleRate: 24000,
            channels: 1,
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx.scheduled).toHaveLength(0);
    });

    it("waitUntilPlaybackFinishes() keeps waiting when a new chunk extends the cursor", async () => {
        const ctx = new MockAudioContext();
        const playback = new LiveVoicePcmPlayback({ audioContextFactory: () => ctx });

        // First chunk: 0.05s
        playback.enqueueTtsAudio(pcmChunk(new Array(1200).fill(0)));

        let resolved = false;
        const wait = playback.waitUntilPlaybackFinishes().then(() => {
            resolved = true;
        });

        // The waiter is pending against the 0.05s cursor.
        await Promise.resolve();
        expect(resolved).toBe(false);

        // Enqueue a second chunk before the first finishes — extends the
        // cursor from 0.05s to 0.15s.
        playback.enqueueTtsAudio(pcmChunk(new Array(2400).fill(0))); // 0.1s

        // Advance past where the FIRST chunk ended. The waiter must NOT
        // resolve here — buffered audio still extends to 0.15s.
        ctx.advanceTo(0.05);
        // Give the rescheduled timer enough wall time to fire if it were
        // pointed at the old cursor (~50ms is what the original waiter delay
        // was). After this, the still-pending timer should be a ~100ms one
        // counting toward the extended cursor.
        await new Promise((r) => setTimeout(r, 60));
        expect(resolved).toBe(false);

        // Advance past the extended cursor — the rescheduled timer fires
        // shortly after, resolving the waiter.
        ctx.advanceTo(0.2);
        await wait;
        expect(resolved).toBe(true);
        expect(playback.isPlaying).toBe(false);
    });
});

/**
 * LiveVoicePcmPlayback — gapless streaming playback for live voice TTS.
 *
 * Mirrors `clients/macos/vellum-assistant/Features/Voice/LiveVoiceAudioPlayer.swift`
 * (pipelined PCM chunk fix in commit 39cdb36bae) and conforms to the
 * `LiveVoiceAudioPlaying` protocol in `LiveVoiceChannelManager.swift`.
 *
 * Gapless scheduling: each chunk is scheduled at
 * `Math.max(currentTime, nextStartTime)` and the cursor advances by the
 * buffer's duration. Awaiting `onended` between chunks would introduce
 * audible gaps from event-loop latency.
 *
 * Non-PCM payloads are dropped: the web live-voice path is PCM only, so we
 * keep the protocol surface but skip `<audio>`-element fallbacks.
 */

const PCM_MIME_PREFIX = "audio/pcm";
const BYTES_PER_SAMPLE = 2; // 16-bit signed little-endian PCM
const INT16_MAX = 32768;

export interface LiveVoiceTtsChunk {
    pcm: Uint8Array;
    mimeType: string;
    sampleRate: number;
    channels: number;
}

/**
 * Minimal slice of the Web Audio surface this module depends on. Tests use a
 * stand-in implementation; production code receives a real `AudioContext`.
 */
export interface PcmAudioContextLike {
    readonly currentTime: number;
    readonly destination: AudioDestinationNodeLike;
    createBuffer(channels: number, frameCount: number, sampleRate: number): AudioBufferLike;
    createBufferSource(): AudioBufferSourceNodeLike;
}

export type AudioDestinationNodeLike = Record<never, never>;

export interface AudioBufferLike {
    readonly duration: number;
    getChannelData(channel: number): Float32Array;
    copyToChannel?(source: Float32Array, channel: number): void;
}

export interface AudioBufferSourceNodeLike {
    buffer: AudioBufferLike | null;
    onended: ((this: AudioBufferSourceNodeLike, ev: Event) => unknown) | null;
    connect(destination: AudioDestinationNodeLike): void;
    start(when?: number): void;
    stop(when?: number): void;
}

export type AudioContextFactory = () => PcmAudioContextLike;

export interface LiveVoicePcmPlaybackOptions {
    /**
     * Override for the `AudioContext` constructor. Defaults to
     * `globalThis.AudioContext || globalThis.webkitAudioContext`. The factory
     * is invoked lazily on the first `enqueueTtsAudio` call.
     */
    audioContextFactory?: AudioContextFactory;
    /**
     * Optional logger for diagnostics. Defaults to `console`.
     */
    logger?: Pick<Console, "warn">;
}

interface WindowWithWebkitAudio {
    AudioContext?: new () => PcmAudioContextLike;
    webkitAudioContext?: new () => PcmAudioContextLike;
}

function defaultAudioContextFactory(): PcmAudioContextLike {
    const w = globalThis as unknown as WindowWithWebkitAudio;
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
        throw new Error("AudioContext is not available in this environment");
    }
    return new Ctor();
}

export class LiveVoicePcmPlayback {
    private readonly factory: AudioContextFactory;
    private readonly logger: Pick<Console, "warn">;
    private audioContext: PcmAudioContextLike | null = null;
    private nextStartTime = 0;
    private readonly scheduledNodes = new Set<AudioBufferSourceNodeLike>();

    constructor(options: LiveVoicePcmPlaybackOptions = {}) {
        this.factory = options.audioContextFactory ?? defaultAudioContextFactory;
        this.logger = options.logger ?? console;
    }

    /**
     * `true` while at least one scheduled node hasn't drained yet.
     */
    get isPlaying(): boolean {
        if (!this.audioContext) return false;
        return this.audioContext.currentTime < this.nextStartTime;
    }

    /**
     * Schedule a PCM16 LE chunk to play gaplessly after any previously
     * scheduled chunks. Non-PCM payloads are dropped with a warning.
     */
    enqueueTtsAudio(chunk: LiveVoiceTtsChunk): void {
        if (!chunk.mimeType.toLowerCase().startsWith(PCM_MIME_PREFIX)) {
            this.logger.warn(
                `[LiveVoicePcmPlayback] dropping non-PCM chunk (mimeType=${chunk.mimeType})`,
            );
            return;
        }
        if (chunk.pcm.byteLength === 0) return;
        if (chunk.pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
            this.logger.warn(
                "[LiveVoicePcmPlayback] dropping malformed PCM chunk (byteLength not aligned to Int16)",
            );
            return;
        }
        if (chunk.channels < 1 || chunk.sampleRate <= 0) {
            this.logger.warn(
                `[LiveVoicePcmPlayback] dropping PCM chunk with invalid format (channels=${chunk.channels}, sampleRate=${chunk.sampleRate})`,
            );
            return;
        }

        const samples = decodePcm16LeToFloat32(chunk.pcm);
        if (samples.length === 0) return;

        const ctx = this.ensureAudioContext();
        const frameCount = Math.floor(samples.length / chunk.channels);
        if (frameCount === 0) return;

        const buffer = ctx.createBuffer(chunk.channels, frameCount, chunk.sampleRate);
        for (let channel = 0; channel < chunk.channels; channel += 1) {
            const channelData = extractChannel(samples, chunk.channels, channel, frameCount);
            if (buffer.copyToChannel) {
                buffer.copyToChannel(channelData, channel);
            } else {
                const target = buffer.getChannelData(channel);
                target.set(channelData);
            }
        }

        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        const scheduledAt = Math.max(ctx.currentTime, this.nextStartTime);
        this.scheduledNodes.add(node);
        node.onended = () => {
            this.scheduledNodes.delete(node);
        };
        node.start(scheduledAt);
        this.nextStartTime = scheduledAt + buffer.duration;
    }

    /**
     * Stop all scheduled playback immediately and clear the queue. Matches
     * `LiveVoiceAudioPlayer.handleInterrupt()`.
     */
    handleInterrupt(): void {
        this.stopAllScheduledNodes();
        this.nextStartTime = 0;
    }

    /**
     * Let the currently-scheduled tail drain naturally. The cursor isn't
     * reset; new chunks would queue after the existing tail.
     */
    handleEnd(): void {
        // Scheduled nodes drain on their own; `nextStartTime` stays put so
        // `waitUntilPlaybackFinishes()` still observes the residual tail.
    }

    handleSessionError(): void {
        // Same playback effect as an interrupt; observers distinguish the
        // two via the session state, not the player.
        this.handleInterrupt();
    }

    resetForNextResponse(): void {
        // No-op in v1: the scheduling cursor already handles back-to-back
        // responses. Kept on the surface for parity with the macOS protocol.
    }

    /**
     * Resolve once `audioContext.currentTime` catches up to `nextStartTime`.
     * Uses a single `setTimeout` rounded to the residual gap rather than a
     * polling loop, matching `LiveVoiceAudioPlayer.waitUntilPlaybackFinishes()`.
     */
    waitUntilPlaybackFinishes(): Promise<void> {
        const ctx = this.audioContext;
        if (!ctx) return Promise.resolve();
        const remaining = this.nextStartTime - ctx.currentTime;
        if (remaining <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            const delayMs = Math.ceil(remaining * 1000);
            setTimeout(resolve, delayMs);
        });
    }

    private ensureAudioContext(): PcmAudioContextLike {
        if (!this.audioContext) {
            this.audioContext = this.factory();
            this.nextStartTime = 0;
        }
        return this.audioContext;
    }

    private stopAllScheduledNodes(): void {
        for (const node of this.scheduledNodes) {
            try {
                node.stop(0);
            } catch {
                // Stopping an already-finished node throws InvalidStateError
                // per the Web Audio spec.
            }
        }
        this.scheduledNodes.clear();
    }
}

function decodePcm16LeToFloat32(pcm: Uint8Array): Float32Array {
    const sampleCount = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
    const out = new Float32Array(sampleCount);
    // DataView (not Int16Array) so reads stay little-endian on big-endian hosts.
    const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * BYTES_PER_SAMPLE);
    for (let i = 0; i < sampleCount; i += 1) {
        out[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / INT16_MAX;
    }
    return out;
}

function extractChannel(
    interleaved: Float32Array,
    channelCount: number,
    channel: number,
    frameCount: number,
): Float32Array {
    if (channelCount === 1) return interleaved.subarray(0, frameCount);
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
        out[i] = interleaved[i * channelCount + channel] ?? 0;
    }
    return out;
}

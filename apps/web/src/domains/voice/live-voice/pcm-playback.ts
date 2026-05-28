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

// Match only `audio/pcm` exactly (case-insensitive) or `audio/pcm;<parameters>`.
// A raw prefix check would incorrectly accept G.711 codecs like `audio/pcma`
// (A-law) and `audio/pcmu` (mu-law) — those bytes are NOT 16-bit LE PCM.
const PCM_MIME_PATTERN = /^audio\/pcm(?:;|$)/i;
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

interface PendingWaiter {
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
}

export class LiveVoicePcmPlayback {
    private readonly factory: AudioContextFactory;
    private readonly logger: Pick<Console, "warn">;
    private audioContext: PcmAudioContextLike | null = null;
    private nextStartTime = 0;
    private acceptsAudio = true;
    private readonly scheduledNodes = new Set<AudioBufferSourceNodeLike>();
    private readonly pendingWaiters = new Set<PendingWaiter>();

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
        if (!this.acceptsAudio) {
            // Mirrors `LiveVoiceAudioPlayer.stop(reason:)`'s `acceptsAudio = false`
            // gate: once the session has been interrupted or ended, drop any
            // late TTS chunks that race the cancel until `resetForNextResponse()`.
            return;
        }
        if (!PCM_MIME_PATTERN.test(chunk.mimeType.trim())) {
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
        this.rescheduleWaitersForExtendedCursor();
    }

    /**
     * Stop all scheduled playback immediately and clear the queue. Matches
     * `LiveVoiceAudioPlayer.handleInterrupt()` → `stop(reason: .interrupt)`:
     * any late chunks from the interrupted response are dropped via the
     * `acceptsAudio` gate until the next `resetForNextResponse()`.
     */
    handleInterrupt(): void {
        this.stopAllScheduledNodes();
        this.nextStartTime = 0;
        this.acceptsAudio = false;
        this.resolvePendingWaiters();
    }

    /**
     * Stop all scheduled playback and refuse further TTS chunks. Matches
     * `LiveVoiceAudioPlayer.handleEnd()` → `stop(reason: .end)`: once the user
     * has ended the session, TTS must not continue playing — late chunks are
     * dropped via the `acceptsAudio` gate.
     */
    handleEnd(): void {
        this.stopAllScheduledNodes();
        this.nextStartTime = 0;
        this.acceptsAudio = false;
        this.resolvePendingWaiters();
    }

    handleSessionError(): void {
        // Same playback effect as an interrupt; observers distinguish the
        // two via the session state, not the player.
        this.handleInterrupt();
    }

    resetForNextResponse(): void {
        // Re-enable the `acceptsAudio` gate so the next assistant turn can
        // play. Matches `LiveVoiceAudioPlayer.resetForNextResponse()`.
        this.acceptsAudio = true;
    }

    /**
     * Resolve once `audioContext.currentTime` catches up to `nextStartTime`.
     * Uses a single `setTimeout` rounded to the residual gap rather than a
     * polling loop, matching `LiveVoiceAudioPlayer.waitUntilPlaybackFinishes()`.
     *
     * If `handleInterrupt()` or `handleEnd()` runs while a waiter is pending,
     * the waiter is resolved immediately so close/cleanup paths don't block on
     * a stale cursor — mirrors `LiveVoiceAudioPlayer.stop(reason:)` resolving
     * its own waiters on stop.
     */
    waitUntilPlaybackFinishes(): Promise<void> {
        const ctx = this.audioContext;
        if (!ctx) return Promise.resolve();
        const remaining = this.nextStartTime - ctx.currentTime;
        if (remaining <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            const delayMs = Math.ceil(remaining * 1000);
            const waiter: PendingWaiter = {
                timer: setTimeout(() => {
                    this.pendingWaiters.delete(waiter);
                    resolve();
                }, delayMs),
                resolve,
            };
            this.pendingWaiters.add(waiter);
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

    private resolvePendingWaiters(): void {
        for (const waiter of this.pendingWaiters) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
        this.pendingWaiters.clear();
    }

    /**
     * When `enqueueTtsAudio()` extends `nextStartTime`, any pending
     * `waitUntilPlaybackFinishes()` timer was rounded to the old cursor and
     * would resolve too early. Reschedule each pending waiter against the new
     * cursor so callers wait for the actual end of buffered audio. The waiter
     * itself stays pending — only its timer handle is replaced.
     */
    private rescheduleWaitersForExtendedCursor(): void {
        const ctx = this.audioContext;
        if (!ctx) return;
        if (this.pendingWaiters.size === 0) return;
        for (const waiter of this.pendingWaiters) {
            clearTimeout(waiter.timer);
            const remaining = this.nextStartTime - ctx.currentTime;
            const delayMs = remaining > 0 ? Math.ceil(remaining * 1000) : 0;
            waiter.timer = setTimeout(() => {
                this.pendingWaiters.delete(waiter);
                waiter.resolve();
            }, delayMs);
        }
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

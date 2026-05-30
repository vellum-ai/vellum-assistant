import type {
  ResolvedRadioDjBreak,
  ResolvedRadioPlaybackPlan,
  ResolvedRadioTrack,
} from "@/domains/radio/types.js";
import { fetchRadioAudioObjectUrl } from "@/domains/radio/api.js";

export interface RadioProgressEvent {
  positionMs: number;
  remainingMs: number;
}

export interface RadioAudioLike {
  readonly src: string;
  currentTime: number;
  duration: number;
  volume: number;
  paused?: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
  dispose?: () => void;
  addEventListener?: (name: "ended" | "timeupdate", listener: () => void) => void;
  removeEventListener?: (
    name: "ended" | "timeupdate",
    listener: () => void,
  ) => void;
}

export interface RadioAudioControllerOptions {
  createAudio?: (url: string) => Promise<RadioAudioLike> | RadioAudioLike;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  prefetchWindowMs?: number;
  rampDurationMs?: number;
  duckVolume?: number;
  onProgress?: (event: RadioProgressEvent) => void;
  onTrackEnding?: () => void;
  onTrackEnded?: () => void;
}

export interface RadioTransitionParams {
  outgoingTrack?: ResolvedRadioTrack | null;
  djBreak: ResolvedRadioDjBreak;
  nextTrack: ResolvedRadioTrack;
  playbackPlan: ResolvedRadioPlaybackPlan;
}

const DEFAULT_PREFETCH_WINDOW_MS = 12_000;
const DEFAULT_RAMP_DURATION_MS = 1_500;
const DEFAULT_DUCK_VOLUME = 0.18;

type PlayResult = "played" | "paused" | "inactive";

function defaultCreateAudio(url: string): RadioAudioLike {
  const audio = new Audio(url);
  return audio;
}

async function defaultCreateFetchedAudio(url: string): Promise<RadioAudioLike> {
  const objectUrl = await fetchRadioAudioObjectUrl(url);
  const audio = defaultCreateAudio(objectUrl.url);
  audio.dispose = objectUrl.revoke;
  return audio;
}

function defaultRequestAnimationFrame(
  callback: FrameRequestCallback,
): number {
  return requestAnimationFrame(callback);
}

function defaultCancelAnimationFrame(id: number): void {
  cancelAnimationFrame(id);
}

export class RadioAudioController {
  private readonly createAudio: (url: string) => Promise<RadioAudioLike> | RadioAudioLike;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly prefetchWindowMs: number;
  private readonly rampDurationMs: number;
  private readonly duckVolume: number;
  private readonly onProgress?: (event: RadioProgressEvent) => void;
  private readonly onTrackEnding?: () => void;
  private readonly onTrackEnded?: () => void;
  private currentAudio: RadioAudioLike | null = null;
  private currentTrack: ResolvedRadioTrack | null = null;
  private djAudio: RadioAudioLike | null = null;
  private outgoingAudio: RadioAudioLike | null = null;
  private hasFiredTrackEnding = false;
  private currentEndedListener: (() => void) | null = null;
  private currentTimeupdateListener: (() => void) | null = null;
  private disposed = false;
  private pausedByUser = false;
  private operationGeneration = 0;
  private readonly pendingRampFrames = new Set<number>();

  constructor(options: RadioAudioControllerOptions = {}) {
    this.createAudio = options.createAudio ?? defaultCreateFetchedAudio;
    this.requestFrame =
      options.requestAnimationFrame ?? defaultRequestAnimationFrame;
    this.cancelFrame =
      options.cancelAnimationFrame ?? defaultCancelAnimationFrame;
    this.prefetchWindowMs =
      options.prefetchWindowMs ?? DEFAULT_PREFETCH_WINDOW_MS;
    this.rampDurationMs = options.rampDurationMs ?? DEFAULT_RAMP_DURATION_MS;
    this.duckVolume = options.duckVolume ?? DEFAULT_DUCK_VOLUME;
    this.onProgress = options.onProgress;
    this.onTrackEnding = options.onTrackEnding;
    this.onTrackEnded = options.onTrackEnded;
  }

  async playInitial(track: ResolvedRadioTrack): Promise<void> {
    const operationToken = this.beginOperation();
    this.cancelPendingRamps();
    this.detachCurrentAudioListeners();
    this.disposeAudio(this.currentAudio);
    this.disposeAudio(this.djAudio);
    this.disposeAudio(this.outgoingAudio);

    const audio = await this.createAudioForOperation(
      track.audioUrl,
      operationToken,
    );
    if (!audio) return;
    audio.volume = 1;
    this.currentAudio = audio;
    this.currentTrack = track;
    this.djAudio = null;
    this.outgoingAudio = null;
    this.hasFiredTrackEnding = false;
    this.attachCurrentAudioListeners(audio);
    await this.playAudio(audio, operationToken);
  }

  pause(): void {
    this.pausedByUser = true;
    this.outgoingAudio?.pause();
    this.currentAudio?.pause();
    this.djAudio?.pause();
  }

  async resume(): Promise<void> {
    this.pausedByUser = false;
    if (this.currentAudio?.paused !== false) {
      await this.currentAudio?.play();
    }
    if (this.djAudio?.paused) {
      await this.djAudio.play();
    }
  }

  skip(): void {
    this.currentAudio?.pause();
  }

  async applyTransition(params: RadioTransitionParams): Promise<void> {
    const operationToken = this.beginOperation();
    this.cancelPendingRamps();
    const outgoingAudio = this.currentAudio;
    this.disposeAudio(this.djAudio);
    if (this.outgoingAudio && this.outgoingAudio !== outgoingAudio) {
      this.disposeAudio(this.outgoingAudio);
    }

    const [djAudio, nextAudio] = await Promise.all([
      this.createAudioForOperation(params.djBreak.audioUrl, operationToken),
      this.createAudioForOperation(params.nextTrack.audioUrl, operationToken),
    ]);
    if (!djAudio || !nextAudio) {
      this.disposeAudio(djAudio);
      this.disposeAudio(nextAudio);
      return;
    }

    this.outgoingAudio = outgoingAudio;
    this.djAudio = djAudio;
    djAudio.volume = 1;
    nextAudio.volume = 0;

    if (outgoingAudio) {
      this.rampVolume(outgoingAudio, this.duckVolume, this.rampDurationMs, () => {
        this.disposeAudio(outgoingAudio);
      });
    }

    const djPlayResult = await this.playAudio(djAudio, operationToken);
    if (djPlayResult === "inactive") {
      this.disposeAudio(nextAudio);
      return;
    }
    if (djPlayResult === "paused") {
      this.attachNextTrackPaused(nextAudio, params.nextTrack);
      return;
    }

    this.detachCurrentAudioListeners();
    this.currentAudio = nextAudio;
    this.currentTrack = params.nextTrack;
    this.hasFiredTrackEnding = false;
    this.attachCurrentAudioListeners(nextAudio);
    const nextPlayResult = await this.playAudio(nextAudio, operationToken);
    if (nextPlayResult === "inactive") {
      return;
    }
    if (nextPlayResult === "paused") {
      nextAudio.volume = 1;
      return;
    }
    this.rampVolume(nextAudio, 1, this.rampDurationMs);
  }

  dispose(): void {
    this.disposed = true;
    this.pausedByUser = false;
    this.operationGeneration += 1;
    this.cancelPendingRamps();
    this.detachCurrentAudioListeners();
    this.disposeAudio(this.currentAudio);
    this.disposeAudio(this.djAudio);
    this.disposeAudio(this.outgoingAudio);
    this.currentAudio = null;
    this.currentTrack = null;
    this.djAudio = null;
    this.outgoingAudio = null;
  }

  private beginOperation(): number {
    this.disposed = false;
    this.pausedByUser = false;
    this.operationGeneration += 1;
    return this.operationGeneration;
  }

  private isActiveOperation(operationToken: number): boolean {
    return !this.disposed && operationToken === this.operationGeneration;
  }

  private async createAudioForOperation(
    url: string,
    operationToken: number,
  ): Promise<RadioAudioLike | null> {
    const audio = await this.createAudio(url);
    if (!this.isActiveOperation(operationToken)) {
      this.disposeAudio(audio);
      return null;
    }
    return audio;
  }

  private disposeAudio(audio: RadioAudioLike | null | undefined): void {
    if (!audio) return;
    audio.pause();
    audio.dispose?.();
  }

  private async playAudio(
    audio: RadioAudioLike,
    operationToken: number,
  ): Promise<PlayResult> {
    try {
      await audio.play();
    } catch (error) {
      if (
        (!this.isActiveOperation(operationToken) || this.pausedByUser) &&
        isInterruptedPlayError(error)
      ) {
        audio.pause();
        return this.pausedByUser ? "paused" : "inactive";
      }
      throw error;
    }

    if (!this.isActiveOperation(operationToken)) {
      audio.pause();
      return "inactive";
    }
    if (this.pausedByUser) {
      audio.pause();
      return "paused";
    }
    return "played";
  }

  private attachCurrentAudioListeners(audio: RadioAudioLike): void {
    this.currentTimeupdateListener = () => this.handleTimeUpdate(audio);
    this.currentEndedListener = () => this.handleEnded();
    audio.addEventListener?.("timeupdate", this.currentTimeupdateListener);
    audio.addEventListener?.("ended", this.currentEndedListener);
  }

  private attachNextTrackPaused(
    audio: RadioAudioLike,
    track: ResolvedRadioTrack,
  ): void {
    this.djAudio?.pause();
    this.outgoingAudio?.pause();
    this.detachCurrentAudioListeners();
    this.currentAudio = audio;
    this.currentTrack = track;
    this.djAudio = null;
    this.outgoingAudio = null;
    this.hasFiredTrackEnding = false;
    this.attachCurrentAudioListeners(audio);
    audio.volume = 1;
    audio.pause();
  }

  private detachCurrentAudioListeners(): void {
    if (!this.currentAudio) return;
    if (this.currentTimeupdateListener) {
      this.currentAudio.removeEventListener?.(
        "timeupdate",
        this.currentTimeupdateListener,
      );
    }
    if (this.currentEndedListener) {
      this.currentAudio.removeEventListener?.("ended", this.currentEndedListener);
    }
    this.currentTimeupdateListener = null;
    this.currentEndedListener = null;
  }

  private handleTimeUpdate(audio: RadioAudioLike): void {
    const positionMs = Math.max(0, Math.round(audio.currentTime * 1_000));
    const durationMs = this.resolveDurationMs(audio);
    const remainingMs = Math.max(0, durationMs - positionMs);

    this.onProgress?.({ positionMs, remainingMs });

    if (!this.hasFiredTrackEnding && remainingMs <= this.prefetchWindowMs) {
      this.hasFiredTrackEnding = true;
      this.onTrackEnding?.();
    }
  }

  private handleEnded(): void {
    if (this.hasFiredTrackEnding) return;
    this.hasFiredTrackEnding = true;
    this.onTrackEnded?.();
  }

  private resolveDurationMs(audio: RadioAudioLike): number {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      return Math.round(audio.duration * 1_000);
    }
    return this.currentTrack?.durationMs ?? 0;
  }

  private rampVolume(
    audio: RadioAudioLike,
    targetVolume: number,
    durationMs: number,
    onComplete?: () => void,
  ): void {
    if (durationMs <= 0) {
      audio.volume = targetVolume;
      onComplete?.();
      return;
    }

    const startVolume = audio.volume;
    let startTime: number | null = null;
    let currentFrameId: number | null = null;

    const scheduleStep = (): void => {
      currentFrameId = this.requestFrame(step);
      this.pendingRampFrames.add(currentFrameId);
    };

    const step: FrameRequestCallback = (timestamp) => {
      if (currentFrameId !== null) {
        this.pendingRampFrames.delete(currentFrameId);
        currentFrameId = null;
      }
      if (this.disposed) return;
      if (startTime === null) startTime = timestamp;
      const elapsedMs = timestamp - startTime;
      const progress = Math.min(1, elapsedMs / durationMs);
      audio.volume = startVolume + (targetVolume - startVolume) * progress;

      if (progress >= 1) {
        audio.volume = targetVolume;
        onComplete?.();
        return;
      }

      scheduleStep();
    };

    scheduleStep();
  }

  private cancelPendingRamps(): void {
    for (const frameId of this.pendingRampFrames) {
      this.cancelFrame(frameId);
    }
    this.pendingRampFrames.clear();
  }
}

function isInterruptedPlayError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.message.includes("interrupted"))
  );
}

import type {
  ResolvedRadioDjBreak,
  ResolvedRadioPlaybackPlan,
  ResolvedRadioTrack,
} from "@/domains/radio/types.js";

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
  addEventListener?: (name: "ended" | "timeupdate", listener: () => void) => void;
  removeEventListener?: (
    name: "ended" | "timeupdate",
    listener: () => void,
  ) => void;
}

export interface RadioAudioControllerOptions {
  createAudio?: (url: string) => RadioAudioLike;
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

function defaultCreateAudio(url: string): RadioAudioLike {
  return new Audio(url);
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
  private readonly createAudio: (url: string) => RadioAudioLike;
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
    this.createAudio = options.createAudio ?? defaultCreateAudio;
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
    this.currentAudio?.pause();
    this.djAudio?.pause();
    this.outgoingAudio?.pause();

    const audio = this.createAudio(track.audioUrl);
    audio.volume = 1;
    this.currentAudio = audio;
    this.currentTrack = track;
    this.djAudio = null;
    this.outgoingAudio = null;
    this.hasFiredTrackEnding = false;
    this.attachCurrentAudioListeners(audio);
    await audio.play();
    if (!this.isActiveOperation(operationToken)) {
      audio.pause();
      return;
    }
    if (this.pausedByUser) {
      audio.pause();
    }
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
    const djAudio = this.createAudio(params.djBreak.audioUrl);
    const nextAudio = this.createAudio(params.nextTrack.audioUrl);

    this.outgoingAudio = outgoingAudio;
    this.djAudio = djAudio;
    djAudio.volume = 1;
    nextAudio.volume = 0;

    if (outgoingAudio) {
      this.rampVolume(outgoingAudio, this.duckVolume, this.rampDurationMs, () => {
        outgoingAudio.pause();
      });
    }

    await djAudio.play();
    if (!this.isActiveOperation(operationToken)) {
      djAudio.pause();
      nextAudio.pause();
      return;
    }
    if (this.pausedByUser) {
      djAudio.pause();
      this.attachNextTrackPaused(nextAudio, params.nextTrack);
      return;
    }

    this.detachCurrentAudioListeners();
    this.currentAudio = nextAudio;
    this.currentTrack = params.nextTrack;
    this.hasFiredTrackEnding = false;
    this.attachCurrentAudioListeners(nextAudio);
    await nextAudio.play();
    if (!this.isActiveOperation(operationToken)) {
      nextAudio.pause();
      return;
    }
    if (this.pausedByUser) {
      nextAudio.volume = 1;
      nextAudio.pause();
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
    this.currentAudio?.pause();
    this.djAudio?.pause();
    this.outgoingAudio?.pause();
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
    this.detachCurrentAudioListeners();
    this.currentAudio = audio;
    this.currentTrack = track;
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

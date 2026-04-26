export type LiveVoiceMetricsClock = () => number;

export type LiveVoiceMetricsEvent =
  | "session_started"
  | "session_ready"
  | "turn_started"
  | "first_audio"
  | "first_partial"
  | "ptt_release"
  | "final_transcript"
  | "first_assistant_delta"
  | "first_tts_audio"
  | "turn_completed"
  | "turn_cancelled";

export type LiveVoiceTurnStatus = "active" | "completed" | "cancelled";

export interface LiveVoiceMetricsCollectorOptions {
  sessionId: string;
  conversationId?: string;
  clock?: LiveVoiceMetricsClock;
  emit?: (frame: LiveVoiceMetricsFrame) => void;
  recentTurnLimit?: number;
}

export interface LiveVoiceSessionMetrics {
  sessionId: string;
  conversationId?: string;
  startedAtMs: number;
  readyAtMs: number | null;
  startToReadyMs: number | null;
}

export interface LiveVoiceTurnTimestamps {
  startedAtMs: number;
  firstAudioAtMs: number | null;
  firstPartialAtMs: number | null;
  pttReleaseAtMs: number | null;
  finalTranscriptAtMs: number | null;
  firstAssistantDeltaAtMs: number | null;
  firstTtsAudioAtMs: number | null;
  completedAtMs: number | null;
  cancelledAtMs: number | null;
}

export interface LiveVoiceTurnDurations {
  firstAudioToFirstPartialMs: number | null;
  pttReleaseToFinalTranscriptMs: number | null;
  finalTranscriptToFirstAssistantDeltaMs: number | null;
  firstAssistantDeltaToFirstTtsAudioMs: number | null;
  totalTurnDurationMs: number | null;
}

export interface LiveVoiceTurnMetrics {
  turnId: string;
  status: LiveVoiceTurnStatus;
  cancellationReason: string | null;
  timestamps: LiveVoiceTurnTimestamps;
  durations: LiveVoiceTurnDurations;
}

export interface LiveVoiceDurationSummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface LiveVoiceMetricsSummary {
  retainedTurnCount: number;
  completedTurnCount: number;
  cancelledTurnCount: number;
  durations: {
    firstAudioToFirstPartialMs: LiveVoiceDurationSummary;
    pttReleaseToFinalTranscriptMs: LiveVoiceDurationSummary;
    finalTranscriptToFirstAssistantDeltaMs: LiveVoiceDurationSummary;
    firstAssistantDeltaToFirstTtsAudioMs: LiveVoiceDurationSummary;
    totalTurnDurationMs: LiveVoiceDurationSummary;
  };
}

export interface LiveVoiceMetricsSnapshot {
  session: LiveVoiceSessionMetrics;
  activeTurn: LiveVoiceTurnMetrics | null;
  recentTurns: LiveVoiceTurnMetrics[];
  summary: LiveVoiceMetricsSummary;
}

export interface LiveVoiceMetricsFrame {
  type: "metrics";
  event: LiveVoiceMetricsEvent;
  sessionId: string;
  conversationId?: string;
  turnId?: string;
  metrics: LiveVoiceMetricsSnapshot;
}

interface MutableTurn {
  turnId: string;
  status: LiveVoiceTurnStatus;
  cancellationReason: string | null;
  timestamps: LiveVoiceTurnTimestamps;
}

const DEFAULT_RECENT_TURN_LIMIT = 50;

export class LiveVoiceMetricsCollector {
  private readonly sessionId: string;
  private readonly conversationId?: string;
  private readonly clock: LiveVoiceMetricsClock;
  private readonly emitFrame?: (frame: LiveVoiceMetricsFrame) => void;
  private readonly recentTurnLimit: number;
  private readonly sessionStartedAtMs: number;

  private readyAtMs: number | null = null;
  private lastTimestampMs = Number.NEGATIVE_INFINITY;
  private nextTurnNumber = 1;
  private activeTurn: MutableTurn | null = null;
  private readonly recentTurns: MutableTurn[] = [];

  constructor(options: LiveVoiceMetricsCollectorOptions) {
    this.sessionId = options.sessionId;
    this.conversationId = options.conversationId;
    this.clock = options.clock ?? Date.now;
    this.emitFrame = options.emit;
    this.recentTurnLimit = normalizeRecentTurnLimit(options.recentTurnLimit);
    this.sessionStartedAtMs = this.timestamp();
    this.emit("session_started");
  }

  markReady(): LiveVoiceMetricsFrame {
    if (this.readyAtMs === null) {
      this.readyAtMs = this.timestamp();
    }
    return this.emit("session_ready");
  }

  startTurn(turnId = this.createTurnId()): LiveVoiceTurnMetrics {
    if (this.activeTurn !== null) {
      this.cancelTurn("superseded");
    }

    this.activeTurn = {
      turnId,
      status: "active",
      cancellationReason: null,
      timestamps: {
        startedAtMs: this.timestamp(),
        firstAudioAtMs: null,
        firstPartialAtMs: null,
        pttReleaseAtMs: null,
        finalTranscriptAtMs: null,
        firstAssistantDeltaAtMs: null,
        firstTtsAudioAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
      },
    };
    this.emit("turn_started", turnId);
    return snapshotTurn(this.activeTurn);
  }

  markFirstAudio(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstAudioAtMs === null) {
      turn.timestamps.firstAudioAtMs = this.timestamp();
    }
    return this.emit("first_audio", turn.turnId);
  }

  markFirstPartial(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstPartialAtMs === null) {
      turn.timestamps.firstPartialAtMs = this.timestamp();
    }
    return this.emit("first_partial", turn.turnId);
  }

  markPushToTalkRelease(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.pttReleaseAtMs === null) {
      turn.timestamps.pttReleaseAtMs = this.timestamp();
    }
    return this.emit("ptt_release", turn.turnId);
  }

  markFinalTranscript(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.finalTranscriptAtMs === null) {
      turn.timestamps.finalTranscriptAtMs = this.timestamp();
    }
    return this.emit("final_transcript", turn.turnId);
  }

  markFirstAssistantDelta(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstAssistantDeltaAtMs === null) {
      turn.timestamps.firstAssistantDeltaAtMs = this.timestamp();
    }
    return this.emit("first_assistant_delta", turn.turnId);
  }

  markFirstTtsAudio(turnId?: string): LiveVoiceMetricsFrame {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.timestamps.firstTtsAudioAtMs === null) {
      turn.timestamps.firstTtsAudioAtMs = this.timestamp();
    }
    return this.emit("first_tts_audio", turn.turnId);
  }

  completeTurn(turnId?: string): LiveVoiceTurnMetrics {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.status === "active") {
      turn.status = "completed";
      turn.timestamps.completedAtMs = this.timestamp();
      this.finishTurn(turn);
    }
    this.emit("turn_completed", turn.turnId);
    return snapshotTurn(turn);
  }

  cancelTurn(reason = "cancelled", turnId?: string): LiveVoiceTurnMetrics {
    const turn = this.ensureActiveTurn(turnId);
    if (turn.status === "active") {
      turn.status = "cancelled";
      turn.cancellationReason = reason;
      turn.timestamps.cancelledAtMs = this.timestamp();
      this.finishTurn(turn);
    }
    this.emit("turn_cancelled", turn.turnId);
    return snapshotTurn(turn);
  }

  getSnapshot(): LiveVoiceMetricsSnapshot {
    return {
      session: this.getSessionMetrics(),
      activeTurn: this.activeTurn ? snapshotTurn(this.activeTurn) : null,
      recentTurns: this.recentTurns.map(snapshotTurn),
      summary: summarizeTurns(this.recentTurns),
    };
  }

  private getSessionMetrics(): LiveVoiceSessionMetrics {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      startedAtMs: this.sessionStartedAtMs,
      readyAtMs: this.readyAtMs,
      startToReadyMs: duration(this.sessionStartedAtMs, this.readyAtMs),
    };
  }

  private ensureActiveTurn(turnId?: string): MutableTurn {
    if (this.activeTurn === null) {
      return this.mutableStartTurn(turnId ?? this.createTurnId());
    }

    if (turnId !== undefined && this.activeTurn.turnId !== turnId) {
      this.cancelTurn("superseded");
      return this.mutableStartTurn(turnId);
    }

    return this.activeTurn;
  }

  private mutableStartTurn(turnId: string): MutableTurn {
    this.startTurn(turnId);
    if (this.activeTurn === null) {
      throw new Error("Live voice metrics failed to start a turn.");
    }
    return this.activeTurn;
  }

  private finishTurn(turn: MutableTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }

    this.recentTurns.push(cloneMutableTurn(turn));
    while (this.recentTurns.length > this.recentTurnLimit) {
      this.recentTurns.shift();
    }
  }

  private timestamp(): number {
    const raw = this.clock();
    if (!Number.isFinite(raw)) {
      throw new Error(
        `Live voice metrics clock returned a non-finite value: ${raw}`,
      );
    }

    const normalized = Math.max(this.lastTimestampMs, raw);
    this.lastTimestampMs = normalized;
    return normalized;
  }

  private emit(
    event: LiveVoiceMetricsEvent,
    turnId?: string,
  ): LiveVoiceMetricsFrame {
    const frame: LiveVoiceMetricsFrame = {
      type: "metrics",
      event,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      turnId,
      metrics: this.getSnapshot(),
    };
    this.emitFrame?.(frame);
    return frame;
  }

  private createTurnId(): string {
    const turnId = `turn-${this.nextTurnNumber}`;
    this.nextTurnNumber += 1;
    return turnId;
  }
}

function normalizeRecentTurnLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECENT_TURN_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_RECENT_TURN_LIMIT;
  return Math.floor(limit);
}

function cloneMutableTurn(turn: MutableTurn): MutableTurn {
  return {
    turnId: turn.turnId,
    status: turn.status,
    cancellationReason: turn.cancellationReason,
    timestamps: { ...turn.timestamps },
  };
}

function snapshotTurn(turn: MutableTurn): LiveVoiceTurnMetrics {
  const timestamps = { ...turn.timestamps };
  return {
    turnId: turn.turnId,
    status: turn.status,
    cancellationReason: turn.cancellationReason,
    timestamps,
    durations: {
      firstAudioToFirstPartialMs: duration(
        timestamps.firstAudioAtMs,
        timestamps.firstPartialAtMs,
      ),
      pttReleaseToFinalTranscriptMs: duration(
        timestamps.pttReleaseAtMs,
        timestamps.finalTranscriptAtMs,
      ),
      finalTranscriptToFirstAssistantDeltaMs: duration(
        timestamps.finalTranscriptAtMs,
        timestamps.firstAssistantDeltaAtMs,
      ),
      firstAssistantDeltaToFirstTtsAudioMs: duration(
        timestamps.firstAssistantDeltaAtMs,
        timestamps.firstTtsAudioAtMs,
      ),
      totalTurnDurationMs: duration(
        timestamps.startedAtMs,
        timestamps.completedAtMs ?? timestamps.cancelledAtMs,
      ),
    },
  };
}

function summarizeTurns(turns: MutableTurn[]): LiveVoiceMetricsSummary {
  const snapshots = turns.map(snapshotTurn);
  const durations = snapshots.map((turn) => turn.durations);

  return {
    retainedTurnCount: snapshots.length,
    completedTurnCount: snapshots.filter((turn) => turn.status === "completed")
      .length,
    cancelledTurnCount: snapshots.filter((turn) => turn.status === "cancelled")
      .length,
    durations: {
      firstAudioToFirstPartialMs: summarizeDuration(
        durations.map((value) => value.firstAudioToFirstPartialMs),
      ),
      pttReleaseToFinalTranscriptMs: summarizeDuration(
        durations.map((value) => value.pttReleaseToFinalTranscriptMs),
      ),
      finalTranscriptToFirstAssistantDeltaMs: summarizeDuration(
        durations.map((value) => value.finalTranscriptToFirstAssistantDeltaMs),
      ),
      firstAssistantDeltaToFirstTtsAudioMs: summarizeDuration(
        durations.map((value) => value.firstAssistantDeltaToFirstTtsAudioMs),
      ),
      totalTurnDurationMs: summarizeDuration(
        durations.map((value) => value.totalTurnDurationMs),
      ),
    },
  };
}

function summarizeDuration(
  values: Array<number | null>,
): LiveVoiceDurationSummary {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(
  sortedValues: number[],
  percentileValue: number,
): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

function duration(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}

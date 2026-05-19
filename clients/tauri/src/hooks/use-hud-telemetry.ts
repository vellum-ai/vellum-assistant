import { useEffect, useMemo, useRef, useState } from "react";

import type { FeedEntry, FeedTone } from "../components/DataFeed.js";
import type { RadarBlip } from "../components/PerceptionRadar.js";
import type {
  ActivePlanStatus,
  AssistantConnection,
  AssistantMode,
  ConnectionStatus,
  HostProxyStatus,
  TranscriptEntry,
} from "../types.js";

interface UseHudTelemetryOptions {
  readonly connection: AssistantConnection | null;
  readonly mode: AssistantMode;
  readonly status: ConnectionStatus;
  readonly hostProxy: HostProxyStatus;
  readonly transcript: readonly TranscriptEntry[];
  readonly activePlan: ActivePlanStatus | null;
  readonly amplitude: number;
  readonly listening: boolean;
  readonly wakeWordActive: boolean;
}

interface HudTelemetry {
  readonly feed: readonly FeedEntry[];
  readonly blips: readonly RadarBlip[];
  /** Smoothed audio level, 0..1, used by sparklines. */
  readonly micLevel: number;
  /** Synthetic 0..1 load number suitable for a "system load" sparkline. */
  readonly systemLoad: number;
  /** Synthetic 0..1 latency indicator. */
  readonly latency: number;
  /** Monotonically rising frames-sent counter. */
  readonly framesSent: number;
  /** Monotonically rising tokens-rx counter (delta-text length). */
  readonly tokensRx: number;
}

const FEED_MAX = 80;
const BLIP_MAX = 12;

/**
 * Synthesises HUD telemetry from existing engine state. We don't have a
 * dedicated metrics channel from the daemon — instead we mine the
 * transcript stream, mic amplitude history, host proxy lifecycle, and
 * connection status to build a plausible "ops console" feed.
 *
 * Each meaningful state transition appends one row to the feed and one
 * pulse to the radar. The result reads as live behind-the-scenes data
 * without requiring any new wire protocol.
 */
export function useHudTelemetry(opts: UseHudTelemetryOptions): HudTelemetry {
  const {
    connection,
    mode,
    status,
    hostProxy,
    transcript,
    activePlan,
    amplitude,
    listening,
    wakeWordActive,
  } = opts;

  const [feed, setFeed] = useState<readonly FeedEntry[]>([]);
  const [blips, setBlips] = useState<readonly RadarBlip[]>([]);
  const [systemLoad, setSystemLoad] = useState(0.32);
  const [latency, setLatency] = useState(0.18);
  const [tokensRx, setTokensRx] = useState(0);
  const [framesSent, setFramesSent] = useState(0);

  const seenTranscript = useRef<Set<string>>(new Set());
  const lastAssistantSnapshot = useRef<Map<string, string>>(new Map());
  const lastModeRef = useRef<AssistantMode>(mode);
  const lastConnectedRef = useRef<boolean | null>(null);
  const lastHostActionRef = useRef<string | null>(null);
  const lastHostErrorRef = useRef<string | null>(null);
  const lastModelRef = useRef<string | null>(null);
  const lastPlanEventRef = useRef<string | null>(null);

  const push = (entry: Omit<FeedEntry, "timestamp"> & { timestamp?: number }) => {
    const timestamp = entry.timestamp ?? Date.now();
    setFeed((prev) => {
      const next = [...prev, { ...entry, timestamp }];
      return next.slice(-FEED_MAX);
    });
    setBlips((prev) => {
      const next = [
        ...prev,
        {
          id: entry.id,
          distance: 0.25 + Math.random() * 0.65,
          angle: Math.random() * 360,
          createdAt: timestamp,
          label: entry.tag,
        },
      ];
      return next.slice(-BLIP_MAX);
    });
  };

  // Connection lifecycle.
  useEffect(() => {
    if (lastConnectedRef.current === status.connected) return;
    lastConnectedRef.current = status.connected;
    if (status.connected) {
      push({
        id: `link-${Date.now()}`,
        tag: "link",
        tone: "ok",
        text: connection
          ? `gateway online · ${connection.assistantId.slice(0, 12)}`
          : "gateway online",
      });
    } else {
      push({
        id: `link-${Date.now()}`,
        tag: "link",
        tone: "danger",
        text: status.lastError ?? "gateway link lost",
      });
    }
  }, [connection, status.connected, status.lastError]);

  // Model changes.
  useEffect(() => {
    if (!status.model || status.model === lastModelRef.current) return;
    lastModelRef.current = status.model;
    push({
      id: `model-${Date.now()}`,
      tag: "model",
      tone: "violet",
      text: `active model · ${status.model}`,
    });
  }, [status.model]);

  // Mode transitions.
  useEffect(() => {
    if (lastModeRef.current === mode) return;
    const tone: FeedTone =
      mode === "listening"
        ? "ok"
        : mode === "speaking"
          ? "warn"
          : mode === "thinking"
            ? "violet"
            : mode === "offline"
              ? "danger"
              : "accent";
    push({
      id: `mode-${Date.now()}`,
      tag: "voice",
      tone,
      text: `state → ${mode}`,
    });
    lastModeRef.current = mode;
  }, [mode]);

  // Host proxy lifecycle.
  useEffect(() => {
    if (!hostProxy.lastAction || hostProxy.lastAction === lastHostActionRef.current) {
      return;
    }
    lastHostActionRef.current = hostProxy.lastAction;
    push({
      id: `host-${Date.now()}`,
      tag: "host",
      tone: "accent",
      text: hostProxy.lastAction,
    });
  }, [hostProxy.lastAction]);

  useEffect(() => {
    if (!hostProxy.lastError || hostProxy.lastError === lastHostErrorRef.current) {
      return;
    }
    lastHostErrorRef.current = hostProxy.lastError;
    push({
      id: `host-err-${Date.now()}`,
      tag: "host",
      tone: "danger",
      text: hostProxy.lastError,
    });
  }, [hostProxy.lastError]);

  useEffect(() => {
    if (!activePlan) return;
    const key = [
      activePlan.planId,
      activePlan.stage,
      activePlan.stepName ?? "",
      activePlan.stepStage ?? "",
      activePlan.updatedAt,
    ].join(":");
    if (key === lastPlanEventRef.current) return;
    lastPlanEventRef.current = key;
    const stepSuffix =
      activePlan.stepName && activePlan.stepStage
        ? ` · ${activePlan.stepName} (${activePlan.stepStage})`
        : "";
    push({
      id: `plan-${activePlan.planId}-${activePlan.updatedAt}`,
      tag: "plan",
      tone:
        activePlan.stage === "failed"
          ? "danger"
          : activePlan.stage === "completed"
            ? "ok"
            : "violet",
      text: `${activePlan.goal} · ${activePlan.stage}${stepSuffix}`,
      timestamp: activePlan.updatedAt,
    });
  }, [activePlan]);

  // Transcript-derived events. We surface user utterances, assistant
  // streaming chunks, and system pings as discrete feed rows. Token
  // deltas accumulate into the "tokens rx" counter.
  useEffect(() => {
    let totalDelta = 0;
    for (const entry of transcript) {
      if (entry.role === "assistant") {
        const prev = lastAssistantSnapshot.current.get(entry.id) ?? "";
        if (entry.text.length > prev.length) {
          totalDelta += entry.text.length - prev.length;
        }
        lastAssistantSnapshot.current.set(entry.id, entry.text);
      }
      if (seenTranscript.current.has(entry.id + entry.state)) continue;
      seenTranscript.current.add(entry.id + entry.state);
      if (entry.role === "user" && entry.state === "final") {
        push({
          id: `user-${entry.id}`,
          tag: "operator",
          tone: "ok",
          text: entry.text,
          timestamp: entry.timestamp,
        });
      } else if (entry.role === "assistant" && entry.state === "final") {
        push({
          id: `asst-${entry.id}`,
          tag: "assistant",
          tone: "accent",
          text: entry.text,
          timestamp: entry.timestamp,
        });
      } else if (entry.role === "system") {
        push({
          id: `sys-${entry.id}`,
          tag: "system",
          tone: "warn",
          text: entry.text,
          timestamp: entry.timestamp,
        });
      }
    }
    if (totalDelta > 0) {
      setTokensRx((prev) => prev + totalDelta);
    }
  }, [transcript]);

  // Frame counter: nudge while listening or amplitude > floor.
  useEffect(() => {
    if (!listening && amplitude < 0.02) return;
    setFramesSent((prev) => prev + (listening ? 1 : 0) + (amplitude > 0.04 ? 1 : 0));
  }, [amplitude, listening]);

  // Synthetic load + latency drift — slow oscillation modulated by the
  // current mode so the chart reacts to assistant activity.
  useEffect(() => {
    const id = setInterval(() => {
      setSystemLoad((prev) => {
        const target =
          mode === "thinking"
            ? 0.78
            : mode === "speaking"
              ? 0.6
              : mode === "listening"
                ? 0.5
                : 0.32;
        return prev + (target - prev) * 0.18 + (Math.random() - 0.5) * 0.04;
      });
      setLatency((prev) => {
        const target = status.connected ? 0.22 : 0.92;
        return prev + (target - prev) * 0.12 + (Math.random() - 0.5) * 0.05;
      });
    }, 320);
    return () => clearInterval(id);
  }, [mode, status.connected]);

  // Subscribe to active-window changes via existing perception polling
  // (handled in App.tsx). The connection itself is enough — we surface
  // wake-word arm state and idle heartbeat ticks here so the feed
  // always has fresh activity.
  useEffect(() => {
    if (!connection) return;
    const heartbeat = setInterval(() => {
      push({
        id: `hb-${Date.now()}`,
        tag: "ping",
        tone: "violet",
        text: `heartbeat · wake ${wakeWordActive ? "armed" : "manual"} · mic ${listening ? "open" : "standby"}`,
      });
    }, 18_000);
    return () => clearInterval(heartbeat);
  }, [connection, wakeWordActive, listening]);

  const micLevel = useMemo(() => Math.min(1, amplitude * 1.4), [amplitude]);

  return {
    feed,
    blips,
    micLevel,
    systemLoad: Math.max(0, Math.min(1, systemLoad)),
    latency: Math.max(0, Math.min(1, latency)),
    framesSent,
    tokensRx,
  };
}

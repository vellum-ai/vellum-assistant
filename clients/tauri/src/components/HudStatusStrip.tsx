import type { JSX } from "react";

import type {
  ActivePlanStatus,
  AssistantMode,
  ConnectionStatus,
  HostProxyStatus,
} from "../types.js";
import { TickerCounter } from "./TickerCounter.js";

interface HudStatusStripProps {
  readonly status: ConnectionStatus;
  readonly mode: AssistantMode;
  readonly assistantId: string | null;
  readonly listening: boolean;
  readonly conversationActive: boolean;
  readonly wakeWordActive: boolean;
  readonly hostProxy?: HostProxyStatus;
  readonly activePlan?: ActivePlanStatus | null;
  readonly framesSent: number;
  readonly tokensRx: number;
  readonly systemLoad: number;
  readonly latency: number;
}

const MODE_LABEL: Record<AssistantMode, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "RESPONDING",
  offline: "OFFLINE",
};

const MODE_TONE: Record<AssistantMode, string> = {
  idle: "text-hud-accent",
  listening: "text-hud-ok",
  thinking: "text-[#9c8aff]",
  speaking: "text-hud-warn",
  offline: "text-hud-danger",
};

export function HudStatusStrip({
  status,
  mode,
  assistantId,
  listening,
  conversationActive,
  wakeWordActive,
  hostProxy,
  activePlan,
  framesSent,
  tokensRx,
  systemLoad,
  latency,
}: HudStatusStripProps): JSX.Element {
  return (
    <div className="relative z-10 border-t border-hud-panelBorder/50 bg-black/55 px-4 py-2 font-display text-[10px] tracking-[0.3em] text-hud-mute backdrop-blur shadow-[0_-12px_36px_rgba(95,222,255,0.08)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Pill label="ELI" tone="text-hud-accent" />
          <span>{assistantId ? assistantId.slice(0, 12) : "—"}</span>
          {status.model ? (
            <span className="text-hud-accent">{status.model}</span>
          ) : null}
          <span className="text-hud-mute/80">
            tx{" "}
            <TickerCounter value={framesSent} digits={5} />
          </span>
          <span className="text-hud-mute/80">
            rx{" "}
            <TickerCounter value={tokensRx} digits={5} unit="tok" />
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-hud-mute/85 tracking-[0.22em]">
            load
            <span
              className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-hud-panelBorder/30"
              aria-hidden
            >
              <span
                className="telemetry-bar block h-full"
                style={{ width: `${Math.round(systemLoad * 100)}%` }}
              />
            </span>
          </span>
          <span className="flex items-center gap-2 text-hud-mute/85 tracking-[0.22em]">
            lag
            <span
              className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-hud-panelBorder/30"
              aria-hidden
            >
              <span
                className="telemetry-bar warn-bar block h-full"
                style={{ width: `${Math.round(latency * 100)}%` }}
              />
            </span>
          </span>
          <span className={MODE_TONE[mode]}>{MODE_LABEL[mode]}</span>
          <Pill
            label={listening ? "MIC ON" : "MIC OFF"}
            tone={listening ? "text-hud-ok" : "text-hud-mute"}
          />
          {conversationActive && !listening ? (
            <Pill label="CHAT" tone="text-hud-accent" />
          ) : null}
          {wakeWordActive ? <Pill label="WAKE" tone="text-hud-warn" /> : null}
          {activePlan ? <Pill label="PLAN" tone="text-[#9c8aff]" /> : null}
          <Pill
            label={status.connected ? "LINK" : "LINK?"}
            tone={status.connected ? "text-hud-ok" : "text-hud-danger"}
          />
          <Pill
            label={hostProxy?.clientId ? "HOST" : "HOST?"}
            tone={hostProxy?.clientId ? "text-hud-ok" : "text-hud-mute"}
          />
        </div>
      </div>
      {status.lastError || hostProxy?.lastError ? (
        <div className="mt-1 truncate text-hud-danger tracking-normal">
          {status.lastError ?? hostProxy?.lastError}
        </div>
      ) : null}
    </div>
  );
}

function Pill({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: string;
}): JSX.Element {
  return (
    <span
      className={`border border-hud-panelBorder/60 bg-hud-panel/50 px-2 py-0.5 shadow-[0_0_12px_rgba(95,222,255,0.08)] ${tone}`}
    >
      {label}
    </span>
  );
}

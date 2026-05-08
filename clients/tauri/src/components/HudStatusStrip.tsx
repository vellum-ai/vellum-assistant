import type { JSX } from "react";

import type { AssistantMode, ConnectionStatus } from "../types.js";

interface HudStatusStripProps {
  readonly status: ConnectionStatus;
  readonly mode: AssistantMode;
  readonly assistantId: string | null;
  readonly listening: boolean;
  readonly wakeWordActive: boolean;
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
  thinking: "text-hud-accent",
  speaking: "text-hud-warn",
  offline: "text-hud-danger",
};

export function HudStatusStrip({
  status,
  mode,
  assistantId,
  listening,
  wakeWordActive,
}: HudStatusStripProps): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-hud-panelBorder/50 bg-black/30 px-4 py-2 font-display text-[10px] tracking-[0.3em] text-hud-mute">
      <div className="flex items-center gap-3">
        <Pill label="ELI" tone="text-hud-accent" />
        <span>{assistantId ? assistantId.slice(0, 12) : "—"}</span>
        {status.model ? (
          <span className="text-hud-accent">{status.model}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <span className={MODE_TONE[mode]}>{MODE_LABEL[mode]}</span>
        <Pill
          label={listening ? "MIC ON" : "MIC OFF"}
          tone={listening ? "text-hud-ok" : "text-hud-mute"}
        />
        {wakeWordActive ? <Pill label="WAKE" tone="text-hud-warn" /> : null}
        <Pill
          label={status.connected ? "LINK" : "LINK?"}
          tone={status.connected ? "text-hud-ok" : "text-hud-danger"}
        />
      </div>
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
      className={`rounded-sm border border-hud-panelBorder/60 px-2 py-0.5 ${tone}`}
    >
      {label}
    </span>
  );
}

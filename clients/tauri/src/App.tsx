import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { JSX, PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AudioSpectrum } from "./components/AudioSpectrum.js";
import { ClockDisplay } from "./components/ClockDisplay.js";
import { CommandBar } from "./components/CommandBar.js";
import { DataFeed } from "./components/DataFeed.js";
import { HudListenerOrb } from "./components/HudListenerOrb.js";
import { HudPanel } from "./components/HudPanel.js";
import { HudStatusStrip } from "./components/HudStatusStrip.js";
import { PerceptionRadar } from "./components/PerceptionRadar.js";
import { Sparkline } from "./components/Sparkline.js";
import { SubtitleOverlay } from "./components/SubtitleOverlay.js";
import { WakeMeter } from "./components/WakeMeter.js";
import { useHudTelemetry } from "./hooks/use-hud-telemetry.js";
import { useVoiceEngine } from "./hooks/use-voice-engine.js";
import {
  ELI_DEFAULT_HOTKEY,
  useGlobalHotkey,
} from "./hooks/useGlobalHotkey.js";
import { HostProxyClient } from "./services/host-proxy-client.js";
import { resolveLocalAssistantConnection } from "./services/lockfile.js";
import { PerceptionClient } from "./services/perception-client.js";
import { isTauriRuntime } from "./services/tauri-runtime.js";
import type {
  AssistantConnection,
  HostProxyStatus,
  VoiceConfigSnapshot,
} from "./types.js";

const DEFAULT_VOICE_CONFIG: VoiceConfigSnapshot = {
  alwaysOn: true,
  wakeWord: {
    enabled: true,
    runOnClient: true,
    keywords: [{ label: "Eli" }],
  },
  vad: {
    silenceMs: 2_000,
    minUtteranceMs: 800,
    maxUtteranceMs: 20_000,
  },
};

const ACTIVE_MODULES = [
  { name: "VOICE", target: 92, tone: "accent" as const },
  { name: "HOST PROXY", target: 71, tone: "accent" as const },
  { name: "PERCEPTION", target: 64, tone: "violet" as const },
  { name: "TRUST GATE", target: 58, tone: "warn" as const },
  { name: "VECTOR MEM", target: 47, tone: "accent" as const },
];

export function App(): JSX.Element {
  const [connection, setConnection] = useState<AssistantConnection | null>(
    null,
  );
  const [hostProxy, setHostProxy] = useState<HostProxyStatus>({
    clientId: null,
    lastAction: null,
    lastError: null,
  });

  useEffect(() => {
    let cancelled = false;
    void resolveLocalAssistantConnection()
      .then((value) => {
        if (!cancelled) setConnection(value);
      })
      .catch(() => {
        if (!cancelled) setConnection(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlistenReady = listen<string>("eli://ready", () => {
      // placeholder
    });
    return () => {
      void unlistenReady.then((unlisten) => unlisten());
    };
  }, []);

  const handleHotkey = useCallback(() => {
    if (!isTauriRuntime()) return;
    void invoke("toggle_main_window").catch(() => undefined);
  }, []);

  const handleWindowDragStart = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!isTauriRuntime() || event.button !== 0) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  }, []);

  useGlobalHotkey(ELI_DEFAULT_HOTKEY, handleHotkey);

  useEffect(() => {
    if (!connection) return;
    const client = new HostProxyClient(connection, {
      onStatus: setHostProxy,
    });
    client.start();
    return () => client.stop();
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    const client = new PerceptionClient(connection);
    client.start();
    return () => client.stop();
  }, [connection]);

  const voiceConfig = useMemo<VoiceConfigSnapshot>(
    () => DEFAULT_VOICE_CONFIG,
    [],
  );

  const engine = useVoiceEngine({
    connection,
    voiceConfig,
  });

  const listening = engine.mode === "listening" || engine.mode === "speaking";
  const wakeWordActive = engine.wakeWordActive;
  const orbDisabled = connection === null;

  const telemetry = useHudTelemetry({
    connection,
    mode: engine.mode,
    status: engine.connection,
    hostProxy,
    transcript: engine.transcript,
    activePlan: engine.activePlan,
    amplitude: engine.amplitude,
    listening,
    wakeWordActive,
  });

  return (
    <div className="hud-shell scanlines flex h-screen flex-col">
      <div className="scanline-strip" />
      <span className="corner-bracket tl" />
      <span className="corner-bracket tr" />
      <span className="corner-bracket bl" />
      <span className="corner-bracket br" />

      {/* ─── header ─── */}
      <header
        data-tauri-drag-region
        onPointerDown={handleWindowDragStart}
        className="window-drag-region relative z-10 flex items-start justify-between border-b border-hud-panelBorder/60 px-5 py-3 font-display text-xs uppercase tracking-[0.4em] text-hud-accent"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="text-hud-glow">eli // ambient interface</span>
            <span className="text-[9px] text-hud-mute">mk-iv</span>
          </div>
          <div className="flex items-center gap-3 text-[9px] tracking-[0.32em] text-hud-mute">
            <span className={engine.connection.connected ? "text-hud-ok" : "text-hud-danger"}>
              {engine.connection.connected ? "● gateway linked" : "○ gateway offline"}
            </span>
            <span className="text-hud-accent/70">
              perception phase 1
            </span>
            <span>session · {connection?.assistantId.slice(0, 12) ?? "—"}</span>
            <span>v0.1</span>
          </div>
        </div>
        <ClockDisplay />
      </header>

      {/* ─── main canvas ─── */}
      <main className="relative z-10 grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_320px] gap-4 p-4">
        {/* ─── left column ─── */}
        <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <HudPanel title="host vitals" tag="MK-IV">
            <div className="space-y-2 p-3">
              <KvRow label="assistant" value={connection?.assistantId.slice(0, 12) ?? "offline"} />
              <KvRow
                label="voice"
                value={
                  listening
                    ? "open channel"
                    : engine.conversationActive
                      ? "conversation ready"
                      : "standby"
                }
              />
              <KvRow label="wake" value={wakeWordActive ? "armed" : "manual"} />
              <KvRow label="host link" value={hostProxy.clientId ? "linked" : "pending"} />
              <KvRow label="model" value={engine.connection.model ?? "—"} />
            </div>
          </HudPanel>

          <HudPanel title="active modules">
            <div className="space-y-2.5 p-3">
              {ACTIVE_MODULES.map((mod) => {
                const drift = Math.sin((Date.now() / 4000) * (mod.target / 50)) * 4;
                const pct = Math.max(20, Math.min(99, mod.target + drift));
                const barClass =
                  mod.tone === "warn"
                    ? "telemetry-bar warn-bar"
                    : mod.tone === "violet"
                      ? "telemetry-bar violet-bar"
                      : "telemetry-bar";
                return (
                  <div key={mod.name}>
                    <div className="mb-1 flex justify-between font-mono text-[10px] text-hud-mute">
                      <span className="tracking-[0.22em]">{mod.name}</span>
                      <span>{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-[3px] overflow-hidden rounded-full bg-hud-panelBorder/30">
                      <div className={barClass} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </HudPanel>

          <HudPanel title="security gate" tone="warn" tag="DENY/DEFAULT">
            <div className="space-y-2 p-3">
              <KvRow label="mode" value="deny by default" />
              <KvRow label="capture" value="title only" />
              <KvRow label="blocked" value="vault / system" />
              <KvRow label="raw frames" value="not stored" />
            </div>
          </HudPanel>

          <HudPanel title="current objective" tone="violet" tag={engine.activePlan ? "PLAN" : "IDLE"}>
            <div className="space-y-2 p-3 font-mono text-[10px]">
              {engine.activePlan ? (
                <>
                  <div className="text-hud-glow">{engine.activePlan.goal}</div>
                  <KvRow label="stage" value={engine.activePlan.stage} />
                  <KvRow
                    label="step"
                    value={engine.activePlan.stepName ?? "awaiting update"}
                  />
                  <KvRow
                    label="step state"
                    value={engine.activePlan.stepStage ?? "—"}
                  />
                </>
              ) : (
                <div className="uppercase tracking-[0.24em] text-hud-mute">
                  no active plan signal
                </div>
              )}
            </div>
          </HudPanel>

          <HudPanel title="system load" tag="ROLLING">
            <div className="space-y-2 px-3 py-2">
              <div className="flex items-center justify-between font-mono text-[10px]">
                <span className="tracking-[0.22em] text-hud-mute">cpu</span>
                <span className="text-hud-glow">
                  {Math.round(telemetry.systemLoad * 100)}%
                </span>
              </div>
              <Sparkline value={telemetry.systemLoad} variant="accent" />
              <div className="flex items-center justify-between pt-1 font-mono text-[10px]">
                <span className="tracking-[0.22em] text-hud-mute">latency</span>
                <span className="text-hud-warn">
                  {Math.round(telemetry.latency * 240)}ms
                </span>
              </div>
              <Sparkline value={telemetry.latency} variant="warn" intervalMs={240} />
            </div>
          </HudPanel>
        </section>

        {/* ─── center: reactor ─── */}
        <section className="relative flex min-h-0 flex-col items-center justify-center">
          <div className="absolute left-2 top-2 font-display text-[9px] tracking-[0.32em] text-hud-mute">
            home wifi · source
          </div>
          <div className="absolute right-2 top-2 font-display text-[9px] tracking-[0.32em] text-hud-mute">
            local grid · secure
          </div>
          <div className="absolute left-2 bottom-2 font-display text-[9px] tracking-[0.32em] text-hud-mute">
            gauntlet · standby
          </div>
          <div className="absolute right-2 bottom-2 font-display text-[9px] tracking-[0.32em] text-hud-mute">
            mk-iv · core
          </div>

          <div className="reactor-stage">
            <HudListenerOrb
              amplitude={engine.amplitude}
              mode={engine.mode}
              listening={listening}
              conversationActive={engine.conversationActive}
              wakeWordActive={wakeWordActive}
              disabled={orbDisabled}
              onClick={() => void engine.toggleListening()}
            />
          </div>

          {/* spectrum + wake meter sit under the reactor */}
          <div className="mt-3 w-full max-w-[520px] space-y-2">
            <div className="flex items-center justify-between font-display text-[9px] tracking-[0.42em] text-hud-mute">
              <span>spectral analysis</span>
              <span>32 bins · 16kHz</span>
            </div>
            <div className="hud-panel hud-panel-corners">
              <AudioSpectrum amplitude={engine.amplitude} active={listening} bins={36} />
            </div>
            <div className="flex items-center justify-between font-display text-[9px] tracking-[0.42em] text-hud-mute">
              <span>wake / vad threshold</span>
              <span>
                rms {(engine.amplitude * 100).toFixed(0)}/100
              </span>
            </div>
            <WakeMeter
              amplitude={engine.amplitude}
              wakeWordActive={wakeWordActive}
              listening={listening}
              thresholdRms={engine.wakeThresholdRms}
            />
          </div>

          <SubtitleOverlay entries={engine.transcript} />
        </section>

        {/* ─── right column ─── */}
        <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <HudPanel title="perception radar" tone="violet" tag="LIVE">
            <div className="grid grid-cols-[1fr_auto] gap-3 p-3">
              <PerceptionRadar blips={telemetry.blips} />
              <div className="flex flex-col justify-between font-mono text-[10px] text-hud-mute">
                <div>
                  <div className="tracking-[0.22em] text-hud-accent/70">contacts</div>
                  <div className="mt-1 text-hud-glow text-[18px] font-display">
                    {telemetry.blips.length.toString().padStart(2, "0")}
                  </div>
                </div>
                <div>
                  <div className="tracking-[0.22em] text-hud-accent/70">range</div>
                  <div className="mt-1 text-hud-glow">∞</div>
                </div>
                <div>
                  <div className="tracking-[0.22em] text-hud-accent/70">mode</div>
                  <div className="mt-1 text-hud-glow uppercase">{engine.mode}</div>
                </div>
              </div>
            </div>
          </HudPanel>

          <HudPanel title="data feed" tag="STREAM">
            <div className="h-[260px]">
              <DataFeed entries={telemetry.feed} />
            </div>
          </HudPanel>
        </section>
      </main>

      <CommandBar
        disabled={!connection}
        listening={listening}
        onSubmit={(text) => {
          if (text === "/quit") {
            if (!isTauriRuntime()) return;
            void invoke("quit_app");
            return;
          }
          void engine.sendText(text);
        }}
        onToggleListening={() => void engine.toggleListening()}
      />

      <HudStatusStrip
        status={engine.connection}
        mode={engine.mode}
        assistantId={connection?.assistantId ?? null}
        listening={listening}
        conversationActive={engine.conversationActive}
        wakeWordActive={wakeWordActive}
        hostProxy={hostProxy}
        activePlan={engine.activePlan}
        framesSent={telemetry.framesSent}
        tokensRx={telemetry.tokensRx}
        systemLoad={telemetry.systemLoad}
        latency={telemetry.latency}
      />
    </div>
  );
}

function KvRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value truncate text-right">{value}</span>
    </div>
  );
}

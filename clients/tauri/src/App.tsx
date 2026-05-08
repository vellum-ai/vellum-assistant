import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommandBar } from "./components/CommandBar.js";
import { HudListenerOrb } from "./components/HudListenerOrb.js";
import { HudStatusStrip } from "./components/HudStatusStrip.js";
import { TranscriptPane } from "./components/TranscriptPane.js";
import { useVoiceEngine } from "./hooks/use-voice-engine.js";
import {
  ELI_DEFAULT_HOTKEY,
  useGlobalHotkey,
} from "./hooks/useGlobalHotkey.js";
import { resolveLocalAssistantConnection } from "./services/lockfile.js";
import type { AssistantConnection, VoiceConfigSnapshot } from "./types.js";

const DEFAULT_VOICE_CONFIG: VoiceConfigSnapshot = {
  alwaysOn: true,
  wakeWord: {
    enabled: true,
    runOnClient: true,
    keywords: [{ label: "Jarvis" }],
  },
  vad: {
    silenceMs: 700,
    minUtteranceMs: 300,
    maxUtteranceMs: 20_000,
  },
};

export function App(): JSX.Element {
  const [connection, setConnection] = useState<AssistantConnection | null>(
    null,
  );
  const [picovoiceAccessKey, setPicovoiceAccessKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void resolveLocalAssistantConnection().then((value) => {
      if (!cancelled) setConnection(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull a Picovoice access key from the Tauri runtime if the user
  // configured `PICOVOICE_ACCESS_KEY` in the environment. The key never
  // gets bundled — the Rust backend reads it at runtime.
  useEffect(() => {
    void invoke<string | null>("picovoice_access_key").then((value) => {
      if (typeof value === "string" && value.length > 0) {
        setPicovoiceAccessKey(value);
      }
    });
  }, []);

  // Drain Tauri-side events (e.g. tray actions). Reserved for future
  // hooks; today it just observes the ready signal.
  useEffect(() => {
    const unlistenReady = listen<string>("eli://ready", () => {
      // placeholder
    });
    return () => {
      void unlistenReady.then((unlisten) => unlisten());
    };
  }, []);

  const handleHotkey = useCallback(() => {
    void invoke("toggle_main_window").catch(() => undefined);
  }, []);

  useGlobalHotkey(ELI_DEFAULT_HOTKEY, handleHotkey);

  const voiceConfig = useMemo<VoiceConfigSnapshot>(
    () => DEFAULT_VOICE_CONFIG,
    [],
  );

  const engine = useVoiceEngine({
    connection,
    voiceConfig,
    picovoiceAccessKey,
  });

  const listening = engine.mode === "listening" || engine.mode === "speaking";
  const wakeWordActive =
    voiceConfig.wakeWord.enabled && picovoiceAccessKey !== null;

  return (
    <div className="hud-shell scanlines flex flex-col h-screen">
      <div className="scanline-strip" />
      <header className="flex items-center justify-between px-5 py-3 border-b border-hud-panelBorder/60 font-display text-xs tracking-[0.4em] uppercase text-hud-accent">
        <span>eli · jarvis hud</span>
        <span className="text-hud-mute">v0.1</span>
      </header>
      <main className="flex flex-1 min-h-0">
        <section className="w-[42%] flex items-center justify-center relative">
          <HudListenerOrb
            amplitude={engine.amplitude}
            mode={engine.mode}
            listening={listening}
            wakeWordActive={wakeWordActive}
            onClick={() => void engine.toggleListening()}
          />
        </section>
        <section className="flex-1 flex flex-col border-l border-hud-panelBorder/60 bg-hud-panel/40">
          <TranscriptPane entries={engine.transcript} />
          <CommandBar
            disabled={!connection}
            onSubmit={(text) => {
              if (text === "/quit") {
                void invoke("quit_app");
                return;
              }
              void engine.sendText(text);
            }}
            onToggleListening={() => void engine.toggleListening()}
          />
        </section>
      </main>
      <HudStatusStrip
        status={engine.connection}
        mode={engine.mode}
        assistantId={connection?.assistantId ?? null}
        listening={listening}
        wakeWordActive={wakeWordActive}
      />
    </div>
  );
}

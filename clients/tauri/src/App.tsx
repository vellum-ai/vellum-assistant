import { invoke } from "@tauri-apps/api/core";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  ELI_DEFAULT_HOTKEY,
  useGlobalHotkey,
} from "./hooks/useGlobalHotkey.js";

/**
 * Scaffold App shell. The real HUD (transcript, listener orb, voice
 * engine) lands in a follow-up commit; this placeholder verifies the
 * Tauri runtime, global hotkey, and tray plumbing are wired before
 * the React feature work begins.
 */
export function App(): JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void invoke<unknown>("platform_info").then(() => setReady(true));
  }, []);

  const handleHotkey = useCallback(() => {
    void invoke("toggle_main_window").catch(() => undefined);
  }, []);

  useGlobalHotkey(ELI_DEFAULT_HOTKEY, handleHotkey);

  return (
    <div className="hud-shell scanlines flex flex-col h-screen items-center justify-center">
      <div className="scanline-strip" />
      <h1 className="font-display text-3xl tracking-[0.4em] uppercase text-hud-accent">
        eli
      </h1>
      <p className="mt-3 font-mono text-xs text-hud-mute tracking-widest uppercase">
        {ready ? "shell ready · hotkey ⌘⌥space" : "booting…"}
      </p>
    </div>
  );
}

import { useEffect, useState } from "react";

import {
  getAppVersionInfo,
  openAppWebsite,
  type AppVersionInfo,
} from "@/runtime/app-info";
import { isElectron } from "@/runtime/is-electron";

/**
 * Branded About page rendered inside the Electron About BrowserWindow
 * (`clients/macos/src/main/about.ts`). The window is sandboxed,
 * non-resizable, and chromeless except for macOS traffic-light buttons;
 * the layout assumes that frame and centers content vertically.
 *
 * Version + commit SHA + copyright come from the Electron host via the
 * `window.vellum.app.versionInfo()` bridge. Off-Electron (e.g. someone
 * navigates to /assistant/about on the web build), the host wrapper
 * returns `null` and the page renders a generic web fallback rather
 * than crashing.
 */
export function AboutPage() {
  const [info, setInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    void getAppVersionInfo().then(setInfo);
  }, []);

  const display = info ?? FALLBACK;

  return (
    <div className="flex h-svh w-screen flex-col items-center justify-center bg-background px-8 pt-14 pb-8 text-center text-foreground select-none">
      <h1 className="mt-4 text-2xl font-semibold">{display.appName}</h1>
      <p className="text-muted-foreground mt-1 mb-7 text-xs">
        AI assistant for your Mac
      </p>
      <dl className="mb-7 grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground text-right">Version</dt>
        <dd className="text-left font-mono tabular-nums select-text">
          {display.version}
        </dd>
        <dt className="text-muted-foreground text-right">Build</dt>
        <dd className="text-left font-mono tabular-nums select-text">
          {display.commitSha}
        </dd>
      </dl>
      <a
        href={display.website}
        className="text-primary text-sm hover:underline"
        onClick={(event) => {
          // Off Electron, let the browser navigate via the `href`. In
          // Electron the renderer is sandboxed, so the only outbound
          // path is the IPC route through `openAppWebsite()` →
          // `shell.openExternal` in main; suppressing the default
          // there keeps the About BrowserWindow from navigating away
          // from its own route.
          if (!isElectron()) return;
          event.preventDefault();
          void openAppWebsite();
        }}
      >
        {new URL(display.website).host}
      </a>
      <div className="text-muted-foreground mt-auto pt-6 text-[11px]">
        {display.copyright}
      </div>
    </div>
  );
}

const FALLBACK: AppVersionInfo = {
  appName: "Vellum",
  version: "—",
  commitSha: "—",
  copyright: `© ${new Date().getFullYear()} Vellum`,
  website: "https://vellum.ai",
};

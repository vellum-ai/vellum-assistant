/**
 * Browser-side entrypoint for the Vellum web client.
 *
 * This module is built into a self-contained ESM bundle that is:
 *   - loaded by the CLI's local server (`vellum client --interface web`)
 *     via the SPA shell at `/`, which calls `mount()` against `#root`.
 *   - importable directly by the platform via dynamic `import(<bundleUrl>)`,
 *     which then calls `mount()` against a container of its choice.
 *
 * The bundle ships its own React runtime — different assistant versions
 * may ship different React majors, so we don't externalize React. Within
 * a single page load only one bundle is mounted at a time, so the cost is
 * one extra React copy alongside whatever the host page already runs.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import type { MountFn, Unmount } from "./types";

export type { ClientConfig, Unmount } from "./types";

export const mount: MountFn = (el, config): Unmount => {
  const root = createRoot(el);
  root.render(
    <React.StrictMode>
      <App config={config} />
    </React.StrictMode>,
  );
  return () => {
    root.unmount();
  };
};

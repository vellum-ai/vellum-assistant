import { z } from "zod";

import { on } from "./ipc";
import { setShareDiagnostics } from "./sentry";

/**
 * Install the diagnostics consent IPC surface. The renderer publishes
 * `device:share_diagnostics` to main so the main-process Sentry client
 * can be enabled/disabled to match. Fire-and-forget — no response needed.
 */
export const installDiagnosticsIpc = (): void => {
  on(
    "vellum:diagnostics:setShareDiagnostics",
    z.tuple([z.boolean()]),
    ([enabled]) => {
      setShareDiagnostics(enabled);
    },
  );
};

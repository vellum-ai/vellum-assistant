import { z } from "zod";

import { DIAGNOSTICS_SET_SHARE } from "@vellumai/ipc-contract";

import type { DiagnosticsIpc } from "./diagnostics-contract";

/**
 * Install the diagnostics consent IPC surface. The renderer publishes
 * `device:share_diagnostics` to main so the main-process Sentry client
 * can be enabled/disabled to match. Fire-and-forget — no response needed.
 */
export const installDiagnosticsIpc = (
  ipc: DiagnosticsIpc,
  setShareDiagnostics: (enabled: boolean) => void,
): void => {
  ipc.on(
    DIAGNOSTICS_SET_SHARE,
    z.tuple([z.boolean()]),
    ([enabled]) => {
      setShareDiagnostics(enabled);
    },
  );
};

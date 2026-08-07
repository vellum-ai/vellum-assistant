import { z } from "zod";

import { DIAGNOSTICS_SET_SHARE } from "@vellumai/ipc-contract";

import type { DiagnosticsIpc } from "./diagnostics-contract";

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

import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  DIAGNOSTICS_SET_SHARE,
  FEATURE_FLAGS_SET,
  FEEDBACK_DIAGNOSTICS,
  FEEDBACK_LOGS,
  type VellumBridge,
} from "@vellumai/ipc-contract";

const diagnosticsFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "diagnostics",
  install: (registry) => {
    registry.contribute("featureFlags", {
      set: (flags) => {
        ipcRenderer.send(FEATURE_FLAGS_SET, flags);
      },
    });
    registry.contribute("diagnostics", {
      setShareDiagnostics: (enabled) => {
        ipcRenderer.send(DIAGNOSTICS_SET_SHARE, enabled);
      },
    });
    registry.contribute("feedback", {
      diagnostics: () =>
        ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS) as Promise<
          Record<string, unknown>
        >,
      logs: () =>
        ipcRenderer.invoke(FEEDBACK_LOGS) as Promise<string>,
    });
  },
};

export default diagnosticsFeature;

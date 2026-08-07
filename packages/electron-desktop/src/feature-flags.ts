import { z } from "zod";

import { FEATURE_FLAGS_SET } from "@vellumai/ipc-contract";

import type { IpcOn } from "./diagnostics-contract";

export interface FeatureFlagsIpc {
  on: IpcOn;
}

export interface FeatureFlagsSettings {
  write: (flags: Record<string, boolean>) => void;
}

export const installFeatureFlagsIpc = (
  ipc: FeatureFlagsIpc,
  settings: FeatureFlagsSettings,
): void => {
  ipc.on(
    FEATURE_FLAGS_SET,
    z.tuple([z.record(z.string(), z.boolean())]),
    ([flags]) => {
      settings.write(flags);
    },
  );
};

import { z } from "zod";

import { FEATURE_FLAGS_SET } from "@vellumai/ipc-contract";

import { on } from "./ipc.client";

let featureFlags: Record<string, boolean> = {};

export const isFeatureEnabled = (flag: string): boolean =>
  featureFlags[flag] === true;

export const installFeatureFlagsIpc = (): void => {
  on(
    FEATURE_FLAGS_SET,
    z.tuple([z.record(z.string(), z.boolean())]),
    ([flags]) => {
      featureFlags = { ...flags };
    },
  );
};

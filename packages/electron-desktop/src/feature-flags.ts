import { z } from "zod";

import { FEATURE_FLAGS_SET } from "@vellumai/ipc-contract";

export interface FeatureFlagsIpc {
  on: <Args extends unknown[]>(
    channel: string,
    schema: z.ZodType<Args>,
    listener: (args: Args) => void,
  ) => void;
}

export interface FeatureFlagsSettings {
  write: (flags: Record<string, boolean>) => void;
}

/**
 * Install the typed feature-flag IPC surface. The renderer owns the source of
 * truth for assistant feature flags and publishes the full map to main so it
 * can be folded into diagnostics (`feedback.ts`) and gate the tray's
 * multi-assistant menu (`tray.ts`). This is a fire-and-forget publish — there
 * is no value for the renderer to read back — so it uses `on`/`send` like the
 * other state-publish channels rather than a request/response `invoke`.
 *
 * Replaces the former generic `vellum:settings:set` passthrough: the channel
 * now accepts only a `Record<string, boolean>`, so the renderer can no longer
 * write arbitrary settings keys with arbitrary values across the bridge.
 */
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

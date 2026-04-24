/**
 * Skill IPC routes: `host.config.getSection` and `host.config.isFeatureFlagEnabled`.
 *
 * Expose the daemon config and feature-flag resolver to out-of-process skills.
 * `getSection` returns a nested value looked up by dot-path (e.g. `"llm.default"`);
 * `isFeatureFlagEnabled` consults the standard assistant flag resolver so skills
 * observe the same overrides and remote values the in-process code does.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig, getNestedValue } from "../../config/loader.js";
import type { IpcRoute } from "../assistant-server.js";

const GetSectionParams = z.object({
  path: z.string().min(1),
});

const IsFeatureFlagEnabledParams = z.object({
  key: z.string().min(1),
});

export const hostConfigGetSectionRoute: IpcRoute = {
  method: "host.config.getSection",
  handler: (params) => {
    const { path } = GetSectionParams.parse(params);
    const value = getNestedValue(
      getConfig() as unknown as Record<string, unknown>,
      path,
    );
    return value ?? null;
  },
};

export const hostConfigIsFeatureFlagEnabledRoute: IpcRoute = {
  method: "host.config.isFeatureFlagEnabled",
  handler: (params) => {
    const { key } = IsFeatureFlagEnabledParams.parse(params);
    return isAssistantFeatureFlagEnabled(key, getConfig());
  },
};

export const configRoutes: IpcRoute[] = [
  hostConfigGetSectionRoute,
  hostConfigIsFeatureFlagEnabledRoute,
];

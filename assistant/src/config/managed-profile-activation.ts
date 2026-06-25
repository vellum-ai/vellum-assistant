import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import { MANAGED_PROFILE_NAMES } from "./seed-inference-profiles.js";

export const MANAGED_PROFILE_BOOTSTRAP_COMPLETED_KEY =
  "managedProfileBootstrapCompleted";

function readPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function activateManagedProfilesWhenProxyAvailable(
  options: {
    hadManagedProxyBefore?: boolean;
  } = {},
): Promise<boolean> {
  const ctx = await resolveManagedProxyContext();
  if (!ctx.enabled) return false;

  const config = loadRawConfig();
  const llm = readPlainObject(config.llm);
  if (!llm) return false;

  if (llm[MANAGED_PROFILE_BOOTSTRAP_COMPLETED_KEY] === true) return false;

  if (options.hadManagedProxyBefore) {
    llm[MANAGED_PROFILE_BOOTSTRAP_COMPLETED_KEY] = true;
    saveRawConfig(config);
    invalidateConfigCache();
    return false;
  }

  const profiles = readPlainObject(llm?.profiles);
  if (!profiles) return false;

  let changed = false;
  for (const name of MANAGED_PROFILE_NAMES) {
    const profile = readPlainObject(profiles[name]);
    if (profile?.source !== "managed" || profile.status !== "disabled") {
      continue;
    }
    delete profile.status;
    changed = true;
  }

  llm[MANAGED_PROFILE_BOOTSTRAP_COMPLETED_KEY] = true;

  saveRawConfig(config);
  invalidateConfigCache();
  return changed;
}

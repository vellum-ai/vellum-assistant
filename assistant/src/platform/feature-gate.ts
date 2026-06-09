import { getDisablePlatform, getIsPlatform } from "../config/env-registry.js";

export function arePlatformFeaturesEnabled(): boolean {
  if (getIsPlatform()) return true;
  return !getDisablePlatform();
}

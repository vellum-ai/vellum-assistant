import { getIsPlatform, getDisablePlatform } from "../config/env-registry.js";

export function arePlatformFeaturesEnabled(): boolean {
  if (getIsPlatform()) return true;
  return !getDisablePlatform();
}

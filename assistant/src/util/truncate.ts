import { safeStringSlice } from "./unicode.js";

/** Truncate a string to `maxLen` characters, appending `suffix` if truncated. */
export function truncate(str: string, maxLen: number, suffix = "..."): string {
  if (str.length <= maxLen) return str;
  if (maxLen < suffix.length) return safeStringSlice(str, 0, maxLen);
  return safeStringSlice(str, 0, maxLen - suffix.length) + suffix;
}

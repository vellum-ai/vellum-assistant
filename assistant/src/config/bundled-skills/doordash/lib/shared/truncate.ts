/** Truncate a string to `maxLen` characters, appending `suffix` if truncated. */
export function truncate(str: string, maxLen: number, suffix = "..."): string {
  if (str.length <= maxLen) return str;
  if (maxLen < suffix.length) return str.slice(0, maxLen);
  return str.slice(0, maxLen - suffix.length) + suffix;
}

/** Truncate a string to `maxLen` characters, appending `suffix` if truncated. */
export function truncate(str: string, maxLen: number, suffix = '...'): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - suffix.length) + suffix;
}

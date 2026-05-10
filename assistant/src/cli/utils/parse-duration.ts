/**
 * Parse a human-friendly duration string into seconds.
 *
 * Accepted formats:
 *   "60"     → 60   (bare number = seconds)
 *   "60s"    → 60
 *   "5m"     → 300
 *   "1h"     → 3600
 *   "1h30m"  → 5400
 *   "90s"    → 90
 *
 * Note: `--ttl never` is handled at the call site (mapped to ttlSeconds: null);
 * do NOT pass "never" to this function.
 */
export function parseDuration(input: string): number {
  if (/^\d+$/.test(input)) return parseInt(input, 10);
  // Validate the whole string is composed entirely of <digits><unit> groups
  if (!/^(\d+[hms])+$/.test(input)) {
    throw new Error(`Invalid duration: "${input}"`);
  }

  let total = 0;
  const re = /(\d+)(h|m|s)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case "h":
        total += val * 3600;
        break;
      case "m":
        total += val * 60;
        break;
      case "s":
        total += val;
        break;
    }
  }
  if (total === 0) throw new Error(`Invalid duration: "${input}"`);
  return total;
}

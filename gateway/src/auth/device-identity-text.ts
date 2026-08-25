// Store-time caps for device identity text. Both pairing_user_agent (an
// observation) and client_reported_name (an assertion) are attacker-controlled
// text: a device that can name itself can name itself deceptively, so callers
// must cap and sanitize before persisting.

export const MAX_PAIRING_USER_AGENT_CHARS = 512;
export const MAX_CLIENT_REPORTED_NAME_CHARS = 64;

// Strips ASCII control characters (codepoints 0-31, plus DEL at 127) so a
// stored value cannot inject line breaks into anything that later renders
// or logs it.
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      continue;
    }
    out += ch;
  }
  return out;
}

export function capDeviceIdentityText(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = stripControlChars(value).trim();
  if (trimmed === "") {
    return null;
  }
  // Truncate by code point, not UTF-16 code unit, so an astral character
  // (e.g. an emoji surrogate pair) at the boundary is kept or dropped
  // whole rather than split into an unpaired surrogate.
  return Array.from(trimmed).slice(0, maxChars).join("");
}

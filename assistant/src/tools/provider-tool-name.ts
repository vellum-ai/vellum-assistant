import { createHash } from "node:crypto";

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HASH_LENGTH = 12;

export function isProviderSafeToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME_RE.test(name);
}

export function toProviderSafeToolName(rawName: string): string {
  const trimmed = rawName.trim();
  if (isProviderSafeToolName(rawName)) {
    return rawName;
  }

  const hash = createHash("sha256")
    .update(rawName)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const suffix = `__${hash}`;
  const maxBaseLength = PROVIDER_TOOL_NAME_MAX_LENGTH - suffix.length;
  const sanitized =
    trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const base = sanitized.slice(0, maxBaseLength).replace(/_+$/g, "") || "tool";

  return `${base}${suffix}`;
}

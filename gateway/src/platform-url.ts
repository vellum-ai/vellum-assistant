import type { CredentialCache } from "./credential-cache.js";
import { credentialKey } from "./credential-key.js";

/**
 * Resolve the platform base URL from the credential cache, falling back to
 * the `VELLUM_PLATFORM_URL` environment variable. Returns `undefined` when
 * neither source provides a value.
 *
 * The returned URL is trimmed and has any trailing slashes removed so callers
 * can safely append path segments.
 */
export async function getPlatformBaseUrl(
  credentials: CredentialCache,
): Promise<string | undefined> {
  const raw = await credentials.get(
    credentialKey("vellum", "platform_base_url"),
  );
  const url = (
    raw?.trim() ||
    process.env.VELLUM_PLATFORM_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  return url || undefined;
}

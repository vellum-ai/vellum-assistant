/** Apex domain that redirects to the canonical www host. */
export const APEX_DOMAIN = "vellum.ai";

/** Canonical marketing site domain. */
export const WWW_DOMAIN = "www.vellum.ai";

/** The eTLD+1 shared by all Vellum domains. Cookie domain uses a leading dot. */
export const VELLUM_COOKIE_DOMAIN = ".vellum.ai";

/**
 * Hostnames where the assistant is platform-hosted (not local daemon).
 * Used to detect platform-hosted mode for assistant lifecycle management.
 */
export const PLATFORM_HOSTED_HOSTNAMES: readonly string[] = [
  WWW_DOMAIN,
  APEX_DOMAIN,
];

/** Check if a hostname belongs to the vellum.ai domain family. */
export function isVellumDomain(host: string): boolean {
  return host === APEX_DOMAIN || host.endsWith(`.${APEX_DOMAIN}`);
}

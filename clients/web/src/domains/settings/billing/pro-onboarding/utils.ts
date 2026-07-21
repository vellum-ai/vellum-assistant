export const DOMAIN_EXIT_DELAY_MS = 800;

export const PRO_POLL_INTERVAL_MS = 1000;
export const PRO_POLL_TIMEOUT_MS = 10_000;

/** How long WAITING can run before the UI softens its copy ("still working…"). */
export const PROVISION_WAIT_GRACE_MS = 30_000;
/** How long WAITING/RESIZING can run before we give up and show STALLED. */
export const PROVISION_STALL_MS = 90_000;
/** How long the watch must run before the background escape hatch is offered. */
export const PROVISION_ESCAPE_MS = (PROVISION_STALL_MS * 2) / 3;
/** Minimum time a provisioning phase stays on screen so it doesn't flash. */
export const PROVISION_MIN_DWELL_MS = 2_500;
/**
 * How long to wait before re-asking ensure-provisioned when it answered
 * `not_applicable` / `no_active_pro` — the subscription flipped to Pro but the
 * entitlement wasn't visible to the reconcile yet. One retry only.
 */
export const ENSURE_PROVISIONED_RACE_RETRY_MS = 2_000;

const ONBOARDING_MACHINE_DRF_FIELD_KEYS = [
  "machine_size",
  "subdomain",
  "non_field_errors",
] as const;

export const ONBOARDING_ERROR_CODE_MESSAGES: Record<string, string> = {
  subdomain_taken: "That subdomain is already taken. Try another.",
  assistant_already_has_domain:
    "Your assistant already has a custom domain.",
  no_assistant_to_attach_domain:
    "We couldn't find an assistant to attach this domain to.",
  exceeds_machine_tier: "That machine size isn't available on your plan.",
  provisioning_submission_failed:
    "We couldn't queue your upgrade just now. Try again in a moment.",
};

export function extractOnboardingErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.error === "string") {
      const mapped = ONBOARDING_ERROR_CODE_MESSAGES[rec.error];
      if (mapped) return mapped;
    }
    for (const key of ONBOARDING_MACHINE_DRF_FIELD_KEYS) {
      const msgs = rec[key];
      if (Array.isArray(msgs) && typeof msgs[0] === "string") {
        return msgs[0];
      }
    }
    if (typeof rec.detail === "string") {
      return rec.detail;
    }
  }
  return fallback;
}

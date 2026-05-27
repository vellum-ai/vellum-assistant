import type { MachineSizeEnum, MachineTierEnum } from "@/generated/api/types.gen";
import { TIER_TO_SIZES } from "@/lib/billing/machine-sizes";

export const DOMAIN_EXIT_DELAY_MS = 800;

export const PRO_POLL_INTERVAL_MS = 1000;
export const PRO_POLL_TIMEOUT_MS = 10_000;

export const RESTART_NOTICE =
  "Your assistant will briefly restart and be unreachable while this is set up.";

export function allowedMachineSizesForTier(
  tier: MachineTierEnum | null | undefined,
): MachineSizeEnum[] {
  return TIER_TO_SIZES[tier as string] ?? TIER_TO_SIZES.medium!;
}

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

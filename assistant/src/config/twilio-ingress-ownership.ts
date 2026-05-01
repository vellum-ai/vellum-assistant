import {
  TWILIO_PUBLIC_BASE_URL_FIELD,
  TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD,
} from "@vellumai/service-contracts/twilio-ingress";

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function clearTwilioPublicBaseUrlManagedBy(
  raw: Record<string, unknown>,
): void {
  const ingress = asPlainObject(raw.ingress);
  if (!ingress) return;
  delete ingress[TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD];
}

export function configKeySetsTwilioPublicBaseUrl(key: string): boolean {
  return key === `ingress.${TWILIO_PUBLIC_BASE_URL_FIELD}`;
}

export function configPatchSetsTwilioPublicBaseUrl(
  patch: Record<string, unknown>,
): boolean {
  return Object.hasOwn(
    asPlainObject(patch.ingress) ?? {},
    TWILIO_PUBLIC_BASE_URL_FIELD,
  );
}

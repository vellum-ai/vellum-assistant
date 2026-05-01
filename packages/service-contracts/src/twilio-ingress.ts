export const TWILIO_PUBLIC_BASE_URL_FIELD = "twilioPublicBaseUrl";
export const TWILIO_PUBLIC_BASE_URL_MANAGED_BY_FIELD =
  "twilioPublicBaseUrlManagedBy";
export const VELAY_TWILIO_PUBLIC_BASE_URL_MANAGER = "velay";

export function normalizePublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : undefined;
}

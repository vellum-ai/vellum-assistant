function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function clearPublicBaseUrlManagedBy(
  raw: Record<string, unknown>,
): void {
  const ingress = asPlainObject(raw.ingress);
  if (!ingress) return;
  delete ingress.publicBaseUrlManagedBy;
}

export function configKeySetsPublicBaseUrl(key: string): boolean {
  return key === "ingress.publicBaseUrl";
}

export function configPatchSetsPublicBaseUrl(
  patch: Record<string, unknown>,
): boolean {
  return Object.hasOwn(asPlainObject(patch.ingress) ?? {}, "publicBaseUrl");
}

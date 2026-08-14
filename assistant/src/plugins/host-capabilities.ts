import semver from "semver";

export const HOST_CAPABILITIES = Object.freeze({
  "plugins.activation.requirements": "1.0.0",
  "plugins.readiness": "1.0.0",
} as const);

export type HostCapabilityId = keyof typeof HOST_CAPABILITIES;

export function resolveHostCapabilityVersion(id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(HOST_CAPABILITIES, id)
    ? HOST_CAPABILITIES[id as HostCapabilityId]
    : undefined;
}

export function satisfiesHostCapability(
  id: string,
  requiredRange: string,
): boolean {
  const version = resolveHostCapabilityVersion(id);
  return (
    version !== undefined &&
    semver.satisfies(version, requiredRange, { includePrerelease: true })
  );
}

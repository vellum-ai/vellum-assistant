/**
 * Organization ID state management.
 *
 * Keeps the active organization ID in module-level state (for request
 * interceptors) and sessionStorage (for tab persistence). Exposes a
 * `useSyncExternalStore`-compatible subscription so React components
 * re-render when the active org changes.
 */

const ACTIVE_ORGANIZATION_STORAGE_KEY = "vellum_active_organization_id";

let requestOrganizationId: string | null = null;
const requestOrganizationIdListeners = new Set<() => void>();

interface OrganizationWithId {
  id: string;
}

function getSessionStorage(): Storage | null {
  if (typeof globalThis.sessionStorage === "undefined") {
    return null;
  }
  return globalThis.sessionStorage;
}

export function getStoredOrganizationId(): string | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    return storage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredOrganizationId(organizationId: string): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, organizationId);
  } catch {
    // ignore storage failures
  }
}

function clearStoredOrganizationId(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function getActiveOrganizationIdForRequests(): string | null {
  if (requestOrganizationId) {
    return requestOrganizationId;
  }

  const stored = getStoredOrganizationId();
  if (stored) {
    requestOrganizationId = stored;
    return stored;
  }

  return null;
}

export function setActiveOrganizationIdForRequests(
  organizationId: string | null,
): void {
  requestOrganizationId = organizationId;

  if (organizationId) {
    setStoredOrganizationId(organizationId);
  } else {
    clearStoredOrganizationId();
  }

  requestOrganizationIdListeners.forEach((listener) => {
    listener();
  });
}

export function subscribeToActiveOrganizationIdForRequests(
  listener: () => void,
): () => void {
  requestOrganizationIdListeners.add(listener);
  return () => {
    requestOrganizationIdListeners.delete(listener);
  };
}

export function resolveActiveOrganizationId<T extends OrganizationWithId>(
  organizations: readonly T[],
  storedOrganizationId: string | null | undefined,
): string | null {
  if (organizations.length === 0) {
    return null;
  }

  if (
    storedOrganizationId &&
    organizations.some((org) => org.id === storedOrganizationId)
  ) {
    return storedOrganizationId;
  }

  return organizations[0]!.id;
}

/**
 * Platform ids whose synced avatar was just outranked by fresher local
 * evidence, stamped with when. The daemon syncs the change to the platform
 * asynchronously and the platform's read path can lag behind the write, so
 * any list that lands inside the window may still carry the old URL; it is
 * dropped for that id. After the window the platform copy is trusted again.
 */
export const AVATAR_SUPERSEDE_WINDOW_MS = 60_000;

const supersededAt = new Map<string, number>();

export function markAvatarSuperseded(platformAssistantId: string): void {
  supersededAt.set(platformAssistantId, Date.now());
}

/** Inside the window; an expired mark is dropped on the way out. */
export function isAvatarSuperseded(platformAssistantId: string): boolean {
  const at = supersededAt.get(platformAssistantId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at < AVATAR_SUPERSEDE_WINDOW_MS) {
    return true;
  }
  supersededAt.delete(platformAssistantId);
  return false;
}

export function resetAvatarSupersedeForTests(): void {
  supersededAt.clear();
}

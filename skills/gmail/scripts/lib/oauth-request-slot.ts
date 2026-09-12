/**
 * Each `assistant oauth request` is a full CLI process (~80-130 MiB).
 * Cap in-flight spawns so a scan cannot fan out enough children to OOM
 * a 3 Gi cgroup.
 */

export const MAX_CONCURRENT_OAUTH_REQUESTS = 4;

let inFlight = 0;
const waiters: Array<() => void> = [];

export async function acquireOauthRequestSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_OAUTH_REQUESTS) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

export function releaseOauthRequestSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  inFlight -= 1;
}

export async function withOauthRequestSlot<T>(
  fn: () => Promise<T>,
): Promise<T> {
  await acquireOauthRequestSlot();
  try {
    return await fn();
  } finally {
    releaseOauthRequestSlot();
  }
}

export function oauthRequestSlotsInFlight(): number {
  return inFlight;
}

export function resetOauthRequestSlotForTests(): void {
  inFlight = 0;
  waiters.length = 0;
}

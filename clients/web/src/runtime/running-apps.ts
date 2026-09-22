import { isElectron } from "@/runtime/is-electron";

/**
 * Which of the named applications are running on the host, by bundle
 * identifier. Empty off a host that cannot say, which reads as none running:
 * the callers arm things on a "no" and stay out of the way on a "yes", and a
 * host with no answer should not be the reason a key stays dead.
 */
export async function runningApps(
  bundleIds: readonly string[],
): Promise<string[]> {
  const query = window.vellum?.helper?.apps?.running;
  if (!isElectron() || typeof query !== "function") {
    return [];
  }
  try {
    return await query(bundleIds);
  } catch {
    return [];
  }
}

/**
 * Ask an application to quit, the way its Quit menu item would. Resolves
 * whether it was asked; whether it went is for the caller to check.
 */
export async function quitApp(bundleId: string): Promise<boolean> {
  const quit = window.vellum?.helper?.apps?.quit;
  if (!isElectron() || typeof quit !== "function") {
    return false;
  }
  try {
    return await quit(bundleId);
  } catch {
    return false;
  }
}

/** The bundle identifier of the application in front, or `null` off a host that cannot say. */
export async function frontmostApp(): Promise<string | null> {
  const query = window.vellum?.helper?.apps?.frontmost;
  if (!isElectron() || typeof query !== "function") {
    return null;
  }
  try {
    return await query();
  } catch {
    return null;
  }
}

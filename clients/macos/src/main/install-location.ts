import { app } from "electron";

/**
 * Where the running app ended up, and for the negative cases which branch put
 * it there.
 *
 * A packaged app outside /Applications keeps running from a read-only location:
 * a mounted DMG, a quarantined ~/Downloads copy, or the randomized
 * `AppTranslocation` mount macOS substitutes for any quarantined bundle that
 * was launched without a Finder move. `electron-updater` refuses every update
 * there ("Cannot update while running on a read-only volume"), so the install
 * can never take one.
 *
 * `move-to-applications.ts` records the outcome and `sentry.ts` reports it as
 * the `install_location` tag. The branches produce an identical downstream
 * error, so the tag is what tells them apart in the field.
 *
 * This is a leaf: it holds the value and touches only `app`, so the telemetry
 * path can read it without pulling in window or installer code.
 */
export type InstallLocation =
  | "unpackaged"
  | "applications"
  | "relocating"
  | "skipped-pending-open"
  | "conflict-exists-and-running"
  | "declined"
  | "failed";

let installLocation: InstallLocation = "unpackaged";

export const getInstallLocation = (): InstallLocation => installLocation;

export const recordInstallLocation = (location: InstallLocation): void => {
  installLocation = location;
};

/** Whether the app is packaged and running somewhere other than /Applications. */
export const isStrandedOutsideApplications = (): boolean =>
  app.isPackaged && !app.isInApplicationsFolder();

/**
 * Record that a launch carrying a `.vellum` file or a deep link bypassed the
 * relocation, so a packaged app left outside /Applications is attributable to
 * that skip rather than to a failed move.
 */
export const markRelocationSkipped = (): void => {
  if (!app.isPackaged) {
    return;
  }
  installLocation = app.isInApplicationsFolder()
    ? "applications"
    : "skipped-pending-open";
};

// Test seam, exported only for unit-test setup. Production code never
// resets the recorded location.
export const __resetForTesting = (): void => {
  installLocation = "unpackaged";
};

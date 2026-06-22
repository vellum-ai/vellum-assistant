import type { ReleaseListItem } from "./platform-releases.js";
import { compareVersions, versionsEqual } from "./version-compat.js";

export interface UpgradeTargetResolution {
  kind: "ok" | "version-not-found" | "no-releases";
  /** Resolved target version (kind "ok" only). */
  target: string | null;
  /** compareVersions(target, current); null when either side is unknown/unparseable. */
  comparison: number | null;
  isNoOp: boolean;
  isDowngrade: boolean;
}

/**
 * Resolve the upgrade target version from the releases list and compare it
 * against the running version. Pure — callers fetch releases/current first.
 *
 * - An explicit version is validated against the releases list when one is
 *   available (`releases !== null`); absent from the list → "version-not-found".
 * - No explicit version → latest release, skipping non-stable heads
 *   (mirrors the web UI: `releases.find(r => r.is_stable !== false) ?? releases[0]`).
 * - `releases === null` (platform unreachable) with an explicit version
 *   trusts the explicit version; without one → "no-releases".
 */
export function resolveUpgradeTarget(args: {
  explicitVersion: string | null;
  releases: ReleaseListItem[] | null;
  currentVersion: string | undefined;
}): UpgradeTargetResolution {
  const { explicitVersion, releases, currentVersion } = args;

  let target: string | null = null;
  if (explicitVersion) {
    if (releases !== null) {
      const found = releases.find((r) =>
        versionsEqual(r.version ?? "", explicitVersion),
      );
      if (!found) {
        return {
          kind: "version-not-found",
          target: null,
          comparison: null,
          isNoOp: false,
          isDowngrade: false,
        };
      }
    }
    target = explicitVersion;
  } else {
    if (releases === null || releases.length === 0) {
      return {
        kind: "no-releases",
        target: null,
        comparison: null,
        isNoOp: false,
        isDowngrade: false,
      };
    }
    target =
      (releases.find((r) => r.is_stable !== false) ?? releases[0]).version;
  }

  const comparison = currentVersion
    ? compareVersions(target, currentVersion)
    : null;
  const isNoOp = currentVersion
    ? versionsEqual(target, currentVersion)
    : false;

  return {
    kind: "ok",
    target,
    comparison,
    isNoOp,
    isDowngrade: comparison !== null && comparison < 0,
  };
}

export interface UpgradePollState {
  /** Resolved target; null when the server resolved "latest" without reporting it. */
  targetVersion: string | null;
  /** Version observed before the upgrade was triggered. */
  initialVersion: string | null;
  /** Latest current_release_version from the assistant detail endpoint. */
  observedVersion: string | null;
  /** Latest upgrade-status in_progress; null when the endpoint is unavailable. */
  inProgress: boolean | null;
  /** Whether in_progress === true was ever observed during this poll. */
  sawInProgress: boolean;
}

/**
 * Completion predicate for the platform upgrade poll loop. Pure.
 *
 * The primary signal is the DB-backed `current_release_version` (works while
 * the service group restarts or the assistant sleeps); the upgrade-status
 * lock is secondary, used only when the target version is unknown.
 */
export function evaluateUpgradePoll(
  state: UpgradePollState,
): "pending" | "complete" {
  const { targetVersion, initialVersion, observedVersion, inProgress, sawInProgress } =
    state;

  if (targetVersion) {
    return observedVersion && versionsEqual(observedVersion, targetVersion)
      ? "complete"
      : "pending";
  }

  // Target unknown: a version change from the pre-upgrade value is
  // definitive on its own — the upgrade can finish before the first poll,
  // leaving in_progress false without sawInProgress ever being set.
  if (
    observedVersion &&
    initialVersion &&
    !versionsEqual(observedVersion, initialVersion)
  ) {
    return "complete";
  }

  // Otherwise rely on the in-progress lock releasing (e.g. when the
  // pre-upgrade version was unknown).
  if (sawInProgress && inProgress === false) return "complete";

  return "pending";
}

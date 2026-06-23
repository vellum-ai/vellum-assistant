import type {
  ReleaseChannelEnum,
  ReleaseListItem,
} from "@/generated/api/types.gen";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { compareParsed, parseSemver } from "@/utils/semver";

export const RUNTIME_RELEASES_REFETCH_INTERVAL_MS = 20 * 60 * 1000;
export const LOCAL_RUNTIME_RELEASES_FETCH_LIMIT = 100;

const DISMISSED_KEY_PREFIX = "vellum:runtimeUpgradeDismissed";
const LEGACY_LOCAL_DISMISSED_KEY_PREFIX =
  "vellum:localRuntimeUpgradeDismissed";

export function isLocalBuildVersion(
  version: string | null | undefined,
): boolean {
  const parsed = version ? parseSemver(version) : null;
  return parsed?.pre?.split(".")[0] === "local";
}

export function getLatestRuntimeRelease(
  releases: ReleaseListItem[] | undefined,
): ReleaseListItem | undefined {
  const runtimeReleases =
    releases?.filter((release) => !isLocalBuildVersion(release.version)) ?? [];
  return (
    runtimeReleases.find((release) => release.is_stable !== false) ??
    runtimeReleases[0]
  );
}

export function isRuntimeUpgradeAvailable(
  currentVersion: string | null | undefined,
  targetVersion: string | null | undefined,
): boolean {
  if (!currentVersion || !targetVersion) return false;
  const target = parseSemver(targetVersion);
  const current = parseSemver(currentVersion);
  if (!target || !current) return targetVersion !== currentVersion;
  return compareParsed(target, current) > 0;
}

export function getVisibleReleaseChannel(
  releaseChannel: ReleaseChannelEnum | undefined,
  previewChannelEnabled: boolean,
): ReleaseChannelEnum {
  return previewChannelEnabled && releaseChannel === "preview"
    ? "preview"
    : "stable";
}

function dismissedKey(
  prefix: string,
  assistantId: string,
  targetVersion: string,
): string {
  return `${prefix}:${assistantId}:${targetVersion}`;
}

export function isRuntimeUpgradeDismissed(
  assistantId: string,
  targetVersion: string,
): boolean {
  return (
    getLocalSetting(
      dismissedKey(DISMISSED_KEY_PREFIX, assistantId, targetVersion),
      "",
    ) === "true" ||
    getLocalSetting(
      dismissedKey(LEGACY_LOCAL_DISMISSED_KEY_PREFIX, assistantId, targetVersion),
      "",
    ) === "true"
  );
}

export function dismissRuntimeUpgrade(
  assistantId: string,
  targetVersion: string,
): void {
  setLocalSetting(
    dismissedKey(DISMISSED_KEY_PREFIX, assistantId, targetVersion),
    "true",
  );
}

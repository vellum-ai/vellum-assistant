import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export function shouldRestoreDesktopChromeSession(profileDir: string): boolean {
  const lastUsed = readProfileMetadata(
    join(profileDir, "Local State"),
  )?.last_used;
  const profileName =
    typeof lastUsed === "string" &&
    lastUsed !== "" &&
    lastUsed !== "." &&
    lastUsed !== ".." &&
    basename(lastUsed) === lastUsed
      ? lastUsed
      : "Default";
  return (
    readProfileMetadata(join(profileDir, profileName, "Preferences"))
      ?.exit_type === "Crashed"
  );
}

function readProfileMetadata(
  path: string,
): { last_used?: unknown; exit_type?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && "profile" in value) {
      const profile = value.profile;
      if (profile && typeof profile === "object" && !Array.isArray(profile)) {
        return profile;
      }
    }
  } catch {
    // Leave missing or unreadable session metadata to Chrome's normal startup.
  }
  return undefined;
}

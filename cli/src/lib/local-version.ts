import { execSync } from "child_process";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

/**
 * Compute a fully-qualified local dev version string.
 *
 * Format: `<pkg.version>-local.<YYYYMMDDHHMMSS>.<shortsha>`
 *
 * This mirrors the macOS client's `build.sh` convention so the
 * service-group version displayed in the About window matches.
 * The result is used to set `APP_VERSION` in the daemon's environment
 * before it starts — that way `version.ts` picks it up via
 * `process.env.APP_VERSION` and it works for any postfix format
 * (local, dev, staging, etc.).
 */
export function computeLocalVersion(): string {
  const base = cliPkg.version;

  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // git not available or not in a repo
  }

  return `${base}-local.${ts}.${sha}`;
}

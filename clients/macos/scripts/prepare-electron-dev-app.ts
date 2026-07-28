#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const ELECTRON_APP = path.join(
  ROOT_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
const ELECTRON_INFO_PLIST = path.join(
  ELECTRON_APP,
  "Contents",
  "Info.plist",
);

// Sentinel marking that we've restarted the Dock for this patched bundle.
// Lives in `dist/` but OUTSIDE `Electron.app/` so it doesn't disturb the
// bundle's code signature. Wiped when `electron` is reinstalled (which resets
// the plist to stock "Electron"), so the next prepare re-busts the Dock.
const DOCK_BUST_MARKER = path.join(
  ROOT_DIR,
  "node_modules",
  "electron",
  "dist",
  ".vellum-dock-busted",
);

// macOS keys notification authorization to the bundle identifier. The stock
// Electron.app ships as `com.github.Electron` — an identifier shared by every
// Electron app on the machine, which routinely lands in a denied state and
// makes `new Notification().show()` fail with `UNErrorDomain error 1`
// (notificationsNotAllowed). Stamp our own owned identifier so the dev app
// gets a clean authorization prompt, mirroring electron-builder's dev scheme
// (`com.vellum.vellum-assistant-electron-${env}`) in electron-builder.config.cjs.
const VELLUM_ENVIRONMENT = process.env.VELLUM_ENVIRONMENT || "local";
const DEV_BUNDLE_ID = `com.vellum.vellum-assistant-electron-${VELLUM_ENVIRONMENT}`;

const REQUIRED_PLIST_STRINGS: Record<string, string> = {
  CFBundleDisplayName: "Vellum Electron",
  CFBundleName: "Vellum Electron",
  CFBundleIdentifier: DEV_BUNDLE_ID,
  NSUserNotificationAlertStyle: "alert",
};

const plistBuddy = (args: string[]): string =>
  execFileSync("/usr/libexec/PlistBuddy", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const readPlistString = (key: string): string | null => {
  try {
    return plistBuddy(["-c", `Print :${key}`, ELECTRON_INFO_PLIST]);
  } catch {
    return null;
  }
};

const setPlistString = (key: string, value: string): boolean => {
  if (readPlistString(key) === value) return false;
  try {
    plistBuddy(["-c", `Set :${key} ${value}`, ELECTRON_INFO_PLIST]);
  } catch {
    plistBuddy(["-c", `Add :${key} string ${value}`, ELECTRON_INFO_PLIST]);
  }
  return true;
};

const isValidSignature = (): boolean => {
  try {
    execFileSync(
      "codesign",
      ["--verify", "--deep", "--strict", "--verbose=1", ELECTRON_APP],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
};

if (process.platform !== "darwin") {
  process.exit(0);
}

if (!existsSync(ELECTRON_INFO_PLIST)) {
  console.warn(
    `[prepare-electron-dev-app] Electron.app Info.plist not found at ${ELECTRON_INFO_PLIST}; skipping`,
  );
  process.exit(0);
}

let changed = false;
for (const [key, value] of Object.entries(REQUIRED_PLIST_STRINGS)) {
  changed = setPlistString(key, value) || changed;
}

if (changed || !isValidSignature()) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", ELECTRON_APP], {
    stdio: "inherit",
  });

  // Re-register the (re-signed) bundle with Launch Services so macOS picks up
  // the new identifier — without this the first `.show()` may not surface an
  // authorization prompt and the app won't appear under
  // System Settings → Notifications. Best-effort: never block the dev flow.
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFileSync(lsregister, ["-f", ELECTRON_APP], { stdio: "inherit" });
  } catch (error) {
    console.warn(
      "[prepare-electron-dev-app] lsregister failed (continuing):",
      error instanceof Error ? error.message : error,
    );
  }
}

// The Dock and Cmd-Tab read a bundle's label from `CFBundleName`, cached by
// macOS keyed to the bundle path. The `lsregister -f` above re-registers the
// bundle but does NOT evict the running Dock's in-memory label, so a bundle
// first seen as the stock "Electron" keeps showing "Electron" even after its
// plist is stamped to "Vellum Electron". Restarting the Dock forces it to
// re-read the name. Done once per patched bundle (tracked by the marker, and
// again whenever the plist actually changes) so routine `bun run dev` restarts
// don't blink the Dock on every launch. Best-effort — never block the dev flow.
if (changed || !existsSync(DOCK_BUST_MARKER)) {
  try {
    execFileSync("killall", ["Dock"], { stdio: "ignore" });
    writeFileSync(DOCK_BUST_MARKER, "");
  } catch {
    // Dock not running, or `killall` unavailable — leave the marker absent so
    // a later run retries.
  }
}

console.log("[prepare-electron-dev-app] Electron.app is ready");

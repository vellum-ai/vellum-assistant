#!/usr/bin/env bun
/**
 * Restore the executable bit on node-pty's `spawn-helper` binary.
 *
 * node-pty launches shells by `posix_spawn()`-ing a small prebuilt helper, but
 * the published `node-pty@1.1.0` tarball ships it without the executable bit
 * (mode 0644), so the spawn fails with `"posix_spawnp failed."` the first time
 * a local terminal is opened. It's purely a file-mode bug — the binary is a
 * correct native executable (N-API, so no rebuild needed).
 *
 * Wired into `postinstall` so every install converges on a runnable helper;
 * electron-builder preserves modes into `app.asar.unpacked`, so this also fixes
 * packaged builds (afterPack.js re-asserts it as defense-in-depth).
 *
 * No-op on Windows, which uses conpty and has no `spawn-helper`.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const prebuildsDir = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules",
  "node-pty",
  "prebuilds",
);

if (process.platform === "win32" || !existsSync(prebuildsDir)) {
  process.exit(0);
}

// One helper per platform-arch (darwin-arm64, darwin-x64); win32 dirs ship
// conpty instead and have no spawn-helper to fix.
for (const entry of readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, entry, "spawn-helper");
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.log(
      `[fix-node-pty-perms] chmod +x prebuilds/${entry}/spawn-helper`,
    );
  }
}

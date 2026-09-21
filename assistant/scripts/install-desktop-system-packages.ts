import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import manifest from "../src/desktop/desktop-system-packages.json" with { type: "json" };

const terminal =
  manifest.wezterm.architectures[
    process.arch as keyof typeof manifest.wezterm.architectures
  ];
if (process.platform !== "linux" || !terminal) {
  throw new Error(
    `Unsupported desktop image platform: ${process.platform}/${process.arch}`,
  );
}

function run(command: string, args: string[]) {
  execFileSync(command, args, {
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    stdio: "inherit",
    windowsHide: true,
  });
}

const directory = mkdtempSync(join(tmpdir(), "desktop-packages-"));
try {
  const deb = join(directory, "wezterm.deb");
  run("curl", [
    "--fail",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--retry",
    "2",
    "--max-time",
    "300",
    "--output",
    deb,
    `https://github.com/wezterm/wezterm/releases/download/${manifest.wezterm.version}/wezterm-${manifest.wezterm.version}.${terminal.suffix}`,
  ]);
  if (
    createHash("sha256").update(readFileSync(deb)).digest("hex") !==
    terminal.sha256
  ) {
    throw new Error("Desktop package download checksum mismatch");
  }
  chmodSync(directory, 0o755);
  chmodSync(deb, 0o644);
  run("/usr/bin/apt-get", ["update"]);
  run("/usr/bin/apt-get", [
    "install",
    "-y",
    "--no-install-recommends",
    "--no-upgrade",
    "--no-remove",
    ...manifest.packages,
    deb,
  ]);
  run("wezterm", ["--version"]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

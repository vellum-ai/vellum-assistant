import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type BunWindowsArch = "x64" | "arm64";

interface BunReleasePin {
  readonly zip: string;
  readonly exe: string;
}

/**
 * sha256 of the Bun release zip (from the release SHASUMS256.txt) and of the
 * bun.exe inside it, per version and architecture. Bump alongside
 * `.tool-versions`.
 */
export const BUN_RELEASE_PINS: Readonly<
  Record<string, Readonly<Record<BunWindowsArch, BunReleasePin>>>
> = {
  "1.3.11": {
    x64: {
      zip: "066f8694f8b7d8df592452746d18f01710d4053e93030922dbc6e8c34a8c4b9f",
      exe: "a8e83a6ff04ddc8e66b9262e6d49052cfae3a8a29276627c3d530af4af238c45",
    },
    arm64: {
      zip: "c7f661d7529ec3f2fdfc1eac39a760c65f526955bce06b74859c532cb4bf00d7",
      exe: "097ebf344a2f2a3bf9725e1deee4891f2e712309384daee73abe4b04cbd22e35",
    },
  },
};

const releaseAssetName = (arch: BunWindowsArch): string =>
  `bun-windows-${arch === "arm64" ? "aarch64" : "x64"}`;

export const bunReleaseUrl = (version: string, arch: BunWindowsArch): string =>
  `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${releaseAssetName(arch)}.zip`;

export const sha256File = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

export const resolveBunReleasePin = (
  version: string,
  arch: BunWindowsArch,
): BunReleasePin => {
  const pin = BUN_RELEASE_PINS[version]?.[arch];
  if (!pin) {
    throw new Error(
      `No sha256 pin for Bun ${version} (${arch}); add it to scripts/bun-release.ts.`,
    );
  }
  return pin;
};

/**
 * Copy a verified bun.exe to `destination`. The host binary is used when its
 * sha256 matches the pin; otherwise the pinned release zip is downloaded,
 * verified, and extracted with the built-in tar.exe.
 */
export const installPinnedBun = async ({
  arch,
  cacheDir,
  destination,
  hostExecutable,
  version,
}: {
  arch: BunWindowsArch;
  cacheDir: string;
  destination: string;
  hostExecutable: string;
  version: string;
}): Promise<"host" | "downloaded"> => {
  const pin = resolveBunReleasePin(version, arch);
  if (sha256File(hostExecutable) === pin.exe) {
    copyFileSync(hostExecutable, destination);
    return "host";
  }

  const url = bunReleaseUrl(version, arch);
  console.log(`Host bun.exe does not match the pin, downloading ${url}`);
  const extractDir = path.join(cacheDir, `bun-${version}-${arch}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const zipPath = path.join(extractDir, "bun.zip");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await Bun.write(zipPath, await response.arrayBuffer());
  const zipHash = sha256File(zipPath);
  if (zipHash !== pin.zip) {
    throw new Error(
      `Bun ${version} (${arch}) zip sha256 mismatch: expected ${pin.zip}, got ${zipHash}.`,
    );
  }

  const extracted = spawnSync("tar", ["-xf", zipPath, "-C", extractDir], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (extracted.status !== 0) {
    throw new Error(`Failed to extract ${zipPath} (exit ${extracted.status}).`);
  }
  const extractedExe = path.join(extractDir, releaseAssetName(arch), "bun.exe");
  const exeHash = sha256File(extractedExe);
  if (exeHash !== pin.exe) {
    throw new Error(
      `Bun ${version} (${arch}) bun.exe sha256 mismatch: expected ${pin.exe}, got ${exeHash}.`,
    );
  }
  copyFileSync(extractedExe, destination);
  return "downloaded";
};

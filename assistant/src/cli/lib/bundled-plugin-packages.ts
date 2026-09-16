/**
 * Materialize reviewed local marketplace packages from the generated bundle.
 * Package keys come from plugins/marketplace.json and never resolve against a
 * caller-controlled filesystem root.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import bundledPackages from "./bundled-plugin-packages.json" with { type: "json" };

interface BundledPackageFile {
  readonly path: string;
  readonly contentBase64: string;
}

interface BundledPackage {
  readonly version: string;
  readonly files: readonly BundledPackageFile[];
}

const packages = bundledPackages.packages as Record<string, BundledPackage>;

export class BundledPluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundledPluginPackageError";
  }
}

/** Return the embedded package when its path and version match the catalog. */
export function getBundledPluginPackage(
  path: string,
  version: string,
): BundledPackage | null {
  const pluginPackage = packages[path];
  return pluginPackage?.version === version ? pluginPackage : null;
}

/** Read one UTF-8 file from an exact embedded package. */
export function readBundledPluginFile(
  path: string,
  version: string,
  filePath: string,
): string | null {
  const file = getBundledPluginPackage(path, version)?.files.find(
    (candidate) => candidate.path === filePath,
  );
  return file
    ? Buffer.from(file.contentBase64, "base64").toString("utf8")
    : null;
}

/** Copy one exact embedded package into an existing staging directory. */
export function materializeBundledPluginPackage(
  path: string,
  version: string,
  destination: string,
): number {
  const pluginPackage = getBundledPluginPackage(path, version);
  if (!pluginPackage) {
    throw new BundledPluginPackageError(
      `Bundled plugin package ${path} @ ${version} is unavailable`,
    );
  }

  for (const file of pluginPackage.files) {
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some(
          (segment) => segment === "." || segment === ".." || segment === "",
        )
    ) {
      throw new BundledPluginPackageError(
        `Bundled plugin package ${path} contains an unsafe file path`,
      );
    }
    const target = join(destination, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.contentBase64, "base64"));
  }
  return pluginPackage.files.length;
}

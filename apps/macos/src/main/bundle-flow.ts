/**
 * Bundle-open orchestration: file-open -> daemon scan -> confirm -> unpack -> render.
 *
 * When the user double-clicks a `.vellum` file in Finder, this module coordinates
 * the full flow: resolves the daemon port from the lockfile, asks the daemon to
 * scan the bundle, shows the confirmation dialog, unpacks the bundle on acceptance,
 * and opens the sandboxed renderer window.
 */
import { app, dialog, net } from "electron";
import path from "node:path";

import {
  getLockfileData,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { BUNDLES_DIR_NAME } from "./app-config";
import { openBundleConfirmation, installBundleConfirmation } from "./bundle-confirmation";
import { unpackBundle, type BundleScanData } from "./bundle-manager";
import { openBundleWindow } from "./bundle-window";

export function resolveDaemonPort(): number | null {
  const result = getLockfileData(resolveLockfilePaths(process.env));
  if (!result.ok) return null;

  for (const assistant of result.data.assistants) {
    if (assistant.resources?.gatewayPort) {
      return assistant.resources.gatewayPort;
    }
  }
  return null;
}

export async function scanBundleViaDaemon(
  filePath: string,
  port: number,
): Promise<BundleScanData | null> {
  try {
    const response = await net.fetch(
      `http://127.0.0.1:${port}/v1/apps/open-bundle`,
      {
        method: "POST",
        body: JSON.stringify({ filePath }),
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as BundleScanData;
  } catch {
    return null;
  }
}

export async function handleBundleFile(filePath: string): Promise<void> {
  const port = resolveDaemonPort();
  if (port == null) {
    dialog.showErrorBox(
      "Cannot open bundle",
      "Vellum assistant is not running. Please start Vellum first.",
    );
    return;
  }

  const scanData = await scanBundleViaDaemon(filePath, port);
  if (!scanData) {
    dialog.showErrorBox("Cannot open bundle", "Failed to scan bundle.");
    return;
  }

  if (!scanData.scanResult.passed) {
    const blocked = scanData.scanResult.findings
      .filter((f) => f.level === "block")
      .map((f) => `• ${f.message}`)
      .join("\n");
    dialog.showErrorBox(
      "Bundle blocked",
      `This bundle cannot be opened due to security findings:\n\n${blocked}`,
    );
    return;
  }

  const accepted = await openBundleConfirmation(scanData);
  if (!accepted) return;

  const bundlesRoot = path.join(app.getPath("userData"), BUNDLES_DIR_NAME);
  let metadata;
  try {
    metadata = await unpackBundle(bundlesRoot, filePath, scanData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox("Cannot open bundle", `Failed to unpack bundle: ${message}`);
    return;
  }

  openBundleWindow(metadata.uuid, scanData.manifest.entry, scanData.manifest.name);
}

export function installBundleFlow(): void {
  installBundleConfirmation();
}

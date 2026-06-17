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
  getGuardianAccessToken,
  getLockfileData,
  resolveConfigDir,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { BUNDLES_DIR_NAME } from "./app-config";
import { resolveCliInvocation } from "./local-mode";
import { openBundleConfirmation, installBundleConfirmation } from "./bundle-confirmation";
import { unpackBundle, type BundleScanData } from "./bundle-manager";
import { openBundleWindow } from "./bundle-window";

interface ActiveGateway {
  assistantId: string;
  port: number;
}

export function resolveActiveGateway(): ActiveGateway | null {
  const result = getLockfileData(resolveLockfilePaths(process.env));
  if (!result.ok) return null;

  const { assistants, activeAssistant } = result.data;
  if (!activeAssistant) return null;

  const entry = assistants.find((a) => a.assistantId === activeAssistant);
  if (!entry?.resources?.gatewayPort) return null;

  return { assistantId: entry.assistantId, port: entry.resources.gatewayPort };
}

async function acquireGatewayToken(assistantId: string): Promise<string | null> {
  const configDir = resolveConfigDir(process.env);
  try {
    const invocation = await resolveCliInvocation();
    const result = await getGuardianAccessToken(assistantId, configDir, invocation, true);
    return result.ok ? result.accessToken : null;
  } catch {
    return null;
  }
}

export async function scanBundleViaDaemon(
  filePath: string,
  port: number,
  token: string | null,
): Promise<BundleScanData | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    // Local gateway base URL (gatewayPort from the lockfile, not the runtime port).
    const gatewayBaseUrl = `http://127.0.0.1:${port}`;
    const response = await net.fetch(`${gatewayBaseUrl}/v1/apps/open-bundle`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
      headers,
    });
    if (!response.ok) return null;
    return (await response.json()) as BundleScanData;
  } catch {
    return null;
  }
}

export async function handleBundleFile(filePath: string): Promise<void> {
  const gateway = resolveActiveGateway();
  if (!gateway) {
    dialog.showErrorBox(
      "Cannot open bundle",
      "Vellum assistant is not running. Please start Vellum first.",
    );
    return;
  }

  const token = await acquireGatewayToken(gateway.assistantId);
  const scanData = await scanBundleViaDaemon(filePath, gateway.port, token);
  if (!scanData) {
    dialog.showErrorBox("Cannot open bundle", "Failed to scan bundle.");
    return;
  }

  if (!scanData.scanResult.passed) {
    const blocked = scanData.scanResult.blocked
      .map((msg) => `• ${msg}`)
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

import { app, powerMonitor } from "electron";
import os from "node:os";
import fs from "node:fs/promises";
import { z } from "zod";

import { handle } from "./ipc";
import { getVersionInfo } from "./about";
import { readSetting } from "./settings";
import { getLogFilePaths } from "./logger";
import { redactText, REDACTION_VERSION } from "./redact";

export interface ElectronDiagnostics {
  app: {
    name: string;
    version: string;
    commitSha: string;
  };
  process: {
    node: string;
    electron: string;
    chrome: string;
    v8: string;
    uptime: number;
  };
  platform: {
    os: string;
    arch: string;
    release: string;
    type: string;
    totalMemory: number;
    freeMemory: number;
  };
  appMetrics: Electron.ProcessMetric[];
  idleTime: number;
  featureFlags: Record<string, boolean> | null;
  redactionVersion: number;
}

export function collectDiagnostics(): ElectronDiagnostics {
  const versionInfo = getVersionInfo();
  return {
    app: {
      name: versionInfo.appName,
      version: versionInfo.version,
      commitSha: versionInfo.commitSha,
    },
    process: {
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      v8: process.versions.v8,
      uptime: process.uptime(),
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      type: os.type(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    appMetrics: app.getAppMetrics(),
    idleTime: powerMonitor.getSystemIdleTime(),
    featureFlags: readSetting("featureFlags"),
    redactionVersion: REDACTION_VERSION,
  };
}

export async function collectRedactedLogs(): Promise<string> {
  const paths = getLogFilePaths();
  const parts: string[] = [];
  for (const p of paths) {
    try {
      const content = await fs.readFile(p, "utf-8");
      parts.push(content);
    } catch {
      // Missing or unreadable log file — skip gracefully
    }
  }
  return redactText(parts.join("\n"));
}

let installed = false;

export function installFeedbackIpc(): void {
  if (installed) return;
  installed = true;

  handle("vellum:feedback:diagnostics", z.tuple([]), () =>
    collectDiagnostics(),
  );

  handle("vellum:feedback:logs", z.tuple([]), () => collectRedactedLogs());
}

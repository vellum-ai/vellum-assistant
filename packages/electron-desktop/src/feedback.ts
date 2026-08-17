import { z } from "zod";

import { FEEDBACK_DIAGNOSTICS, FEEDBACK_LOGS } from "@vellumai/ipc-contract";

import type { FeedbackDependencies, FeedbackIpc } from "./diagnostics-contract";
import { redactText, REDACTION_VERSION } from "./redact";

export type { FeedbackDependencies } from "./diagnostics-contract";

let app: FeedbackDependencies["app"];
let powerMonitor: FeedbackDependencies["powerMonitor"];
let os: FeedbackDependencies["os"];
let fs: { readFile: FeedbackDependencies["readFile"] };
let getVersionInfo: FeedbackDependencies["getVersionInfo"];
let getLogFilePaths: FeedbackDependencies["getLogFilePaths"];
let readSetting: () => Record<string, boolean> | null;
let hasSession: FeedbackDependencies["hasSession"];
let handle: FeedbackIpc["handle"];

export const configureFeedback = (dependencies: FeedbackDependencies): void => {
  ({ app, powerMonitor, os, getVersionInfo, getLogFilePaths, hasSession } =
    dependencies);
  fs = { readFile: dependencies.readFile };
  readSetting = dependencies.getFeatureFlags;
  handle = dependencies.ipc.handle;
};

export interface ElectronDiagnostics {
  app: {
    name: string;
    version: string;
    commitSha: string;
    releaseChannel: string;
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
  session: { authenticated: boolean };
  redactionVersion: number;
}

export function collectDiagnostics(): ElectronDiagnostics {
  const versionInfo = getVersionInfo();
  return {
    app: {
      name: versionInfo.appName,
      version: versionInfo.version,
      commitSha: versionInfo.commitSha,
      releaseChannel: versionInfo.releaseChannel,
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
    featureFlags: readSetting(),
    session: { authenticated: hasSession() },
    redactionVersion: REDACTION_VERSION,
  };
}

export async function collectRedactedLogs(): Promise<string> {
  const paths = getLogFilePaths();
  const parts: string[] = [];
  const contents = await Promise.all(
    paths.map(async (filePath) => {
      try {
        return await fs.readFile(filePath, "utf-8");
      } catch {
        // Missing or unreadable log file, skip gracefully.
        return null;
      }
    }),
  );
  for (const content of contents) {
    if (content !== null) {
      parts.push(content);
    }
  }
  return redactText(parts.join("\n"));
}

let installed = false;

export function installFeedbackIpc(): void {
  if (installed) {
    return;
  }
  installed = true;

  handle(FEEDBACK_DIAGNOSTICS, z.tuple([]), () =>
    collectDiagnostics(),
  );

  handle(FEEDBACK_LOGS, z.tuple([]), () => collectRedactedLogs());
}

import type { z } from "zod";

export type IpcOn = <Args extends unknown[]>(
  channel: string,
  schema: z.ZodType<Args>,
  listener: (args: Args) => void,
) => void;

export interface DiagnosticsIpc {
  on: IpcOn;
}

export interface FeedbackIpc {
  handle: <Args extends unknown[], Result>(
    channel: string,
    schema: z.ZodType<Args>,
    handler: (args: Args) => Result,
  ) => void;
}

export interface FeedbackVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  releaseChannel: string;
}

export interface FeedbackDependencies {
  ipc: FeedbackIpc;
  app: { getAppMetrics: () => Electron.ProcessMetric[] };
  powerMonitor: { getSystemIdleTime: () => number };
  os: {
    release: () => string;
    type: () => string;
    totalmem: () => number;
    freemem: () => number;
  };
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  getVersionInfo: () => FeedbackVersionInfo;
  getLogFilePaths: () => string[];
  getFeatureFlags: () => Record<string, boolean> | null;
  hasSession: () => boolean;
}

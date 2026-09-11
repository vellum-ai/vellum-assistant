import { app } from "electron";
import path from "node:path";

import log, { getLogFilePaths } from "@vellumai/electron-desktop/app-logger";

declare const __VELLUM_ENVIRONMENT__: string;

/**
 * The directory a build's log file lives in.
 *
 * Packaged builds of every channel share one package.json `name`, so
 * electron-log points them all at `~/Library/Logs/@vellumai/macos/`, and a
 * support bundle from one build carries the lines of whichever other builds
 * ran that day. Non-production channels get the same `-<channel>` suffix
 * their userData directory already carries (`macos-dev`, `macos-staging`);
 * production keeps the stock path so existing readers still find it.
 */
export const resolveLogDir = (
  defaultDir: string,
  channel: string,
  isPackaged: boolean,
): string =>
  isPackaged && channel !== "production"
    ? `${defaultDir}-${channel}`
    : defaultDir;

const channel =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

// Consulted on every write and by `getLogFilePaths`, so the sink and the
// diagnostics readers move together.
log.transports.file.resolvePathFn = (vars) =>
  path.join(
    resolveLogDir(vars.libraryDefaultDir, channel, app.isPackaged),
    log.transports.file.fileName,
  );

export default log;
export { getLogFilePaths };

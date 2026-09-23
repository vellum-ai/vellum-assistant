import { configureCompanionCapture } from "@vellumai/electron-desktop/companion-capture-sources";
import { runAppleScript } from "./appleScriptExecutor";
import log from "./logger";
import { getSharedCuHelper } from "./sidecar/shared-cu-helper";

configureCompanionCapture({
  call: (method, params) => getSharedCuHelper().call(method, params),
  runChromeAppleScript: runAppleScript,
  log,
});

export * from "@vellumai/electron-desktop/companion-capture-sources";

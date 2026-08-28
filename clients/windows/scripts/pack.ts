import { spawnSync } from "node:child_process";
import path from "node:path";

import { argValue } from "./cli-args";

const usage = `Usage: bun run pack [flags]

Build and package the Windows app for the target architecture.

Flags:
  --environment, --env <name>  Set VELLUM_ENVIRONMENT (default: dev)
  --debug                      Enable Chrome DevTools in the packaged app
  --help, -h                   Show this help`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const environmentArgument =
  argValue("--environment") ?? argValue("--env");
const hasEnvironmentArgument = process.argv.some(
  (argument) =>
    argument === "--environment" ||
    argument.startsWith("--environment=") ||
    argument === "--env" ||
    argument.startsWith("--env="),
);
if (
  hasEnvironmentArgument &&
  (!environmentArgument || environmentArgument.startsWith("-"))
) {
  console.error("--environment requires a value");
  process.exit(1);
}
const environment =
  environmentArgument?.trim() ||
  process.env.VELLUM_ENVIRONMENT?.trim() ||
  "dev";
const debug = process.argv.includes("--debug");
const env = {
  ...process.env,
  VELLUM_ENVIRONMENT: environment,
  ...(debug ? { VELLUM_ENABLE_CHROME_DEVTOOLS: "true" } : {}),
};

const runBun = (args: string[]): void => {
  const result = spawnSync(process.execPath, args, {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

runBun(["run", "build:runtime"]);
runBun(["run", "build:native-helper"]);
runBun(["run", "build:preview-handler"]);
runBun([
  "x",
  "electron-builder",
  "--win",
  "--config",
  "electron-builder.config.cjs",
  "--publish",
  "never",
]);

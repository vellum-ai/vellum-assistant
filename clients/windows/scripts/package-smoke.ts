import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { argValue } from "./cli-args";

/** Installs, launches, verifies, and uninstalls a packaged NSIS artifact. */

const windowsDir = path.resolve(import.meta.dir, "..");
const requireCjs = createRequire(import.meta.url);
const { productName } = requireCjs("../electron-builder.config.cjs") as {
  productName: string;
};
const packageName = requireCjs("../package.json").name as string;
const env = process.env.VELLUM_ENVIRONMENT || "local";
const scheme = env === "production" ? "vellum" : `vellum-assistant-${env}`;

const fail = (message: string): never => {
  throw new Error(message);
};

const assertExists = (candidate: string, label: string): void => {
  if (!existsSync(candidate)) {
    fail(`${label} is missing: ${candidate}`);
  }
};

const runVerbatim = (executable: string, argLine: string): void => {
  // NSIS `/D=` and `_?=` consume the rest of the raw command line, so the
  // arguments must not be re-quoted even when the path contains spaces.
  // cmd /s /c keeps the executable quoted while leaving the args verbatim.
  const result = spawnSync(
    "cmd.exe",
    [`/d /s /c ""${executable}" ${argLine}"`],
    {
      stdio: "inherit",
      windowsVerbatimArguments: true,
      timeout: 10 * 60 * 1000,
    },
  );
  if (result.status !== 0) {
    fail(`${executable} ${argLine} exited with ${result.status}`);
  }
};

const assertRegistered = (key: string): void => {
  const result = spawnSync("reg", ["query", key], { stdio: "ignore" });
  if (result.status !== 0) {
    fail(`Expected registry key is missing: ${key}`);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  const arch = argValue("--arch") ?? "x64";
  const distDir = path.join(windowsDir, "dist");
  const installer =
    argValue("--installer") ??
    (existsSync(distDir)
      ? readdirSync(distDir)
          .filter((file) => file.endsWith(`-${arch}.exe`))
          .map((file) => path.join(distDir, file))[0]
      : undefined);
  if (!installer || !existsSync(installer)) {
    fail(`No ${arch} installer found; pass --installer <path>`);
    return;
  }
  const localAppData =
    process.env.LOCALAPPDATA ?? fail("LOCALAPPDATA is unset");
  const appData = process.env.APPDATA ?? fail("APPDATA is unset");
  // Per-user location with a space to cover spaces in install paths.
  const installDir = path.join(
    localAppData,
    "Programs",
    `${productName} Smoke`,
  );

  console.log(`Installing ${installer} into ${installDir}`);
  runVerbatim(installer, `/S /D=${installDir}`);

  const appExe = path.join(installDir, `${productName}.exe`);
  assertExists(appExe, "App executable");
  const resources = path.join(installDir, "resources");
  for (const [relative, label] of [
    ["web-dist/index.html", "Web renderer bundle"],
    ["cli-runtime/vellum.exe", "CLI runtime"],
    ["cli-runtime/bun.exe", "Bun runtime"],
    ["cli-runtime/runtime.json", "Runtime manifest"],
    [`native-helper/${arch}/Vellum.WindowsHelper.exe`, "Native helper"],
    ["preview-handler/Vellum.PreviewHandler.dll", "Preview handler DLL"],
    ["tray.ico", "Tray icon"],
  ] as const) {
    assertExists(path.join(resources, relative), label);
  }
  const packagedBun = path.join(resources, "cli-runtime", "bun.exe");
  const bunVersion = spawnSync(packagedBun, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (bunVersion.status !== 0 || !bunVersion.stdout.trim()) {
    fail(`Packaged Bun runtime failed to execute for ${arch}`);
  }
  assertRegistered("HKCU\\Software\\Classes\\.vellum");

  console.log(`Launching ${appExe}`);
  const child = spawn(appExe, [], { stdio: "ignore" });
  const logCandidates = [productName, packageName].flatMap((name) => [
    path.join(appData, name, "logs", "vellum.log"),
    path.join(appData, `${name}-${env}`, "logs", "vellum.log"),
  ]);
  let logFile: string | undefined;
  for (let waited = 0; waited < 120_000 && !logFile; waited += 2_000) {
    await sleep(2_000);
    logFile = logCandidates.find((candidate) => existsSync(candidate));
  }
  if (!logFile) {
    fail(`App produced no log file at ${logCandidates.join(" or ")}`);
    return;
  }
  if (child.exitCode !== null) {
    fail(`App exited early with code ${child.exitCode}`);
  }
  assertRegistered(`HKCU\\Software\\Classes\\${scheme}`);
  console.log(`App is running with logs at ${logFile}`);
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "inherit",
  });
  await sleep(3_000);

  const uninstaller = path.join(installDir, `Uninstall ${productName}.exe`);
  assertExists(uninstaller, "Uninstaller");
  console.log(`Uninstalling via ${uninstaller}`);
  runVerbatim(uninstaller, "/S");

  for (let waited = 0; waited < 30_000; waited += 1_000) {
    if (!existsSync(appExe) && !existsSync(resources)) {
      break;
    }
    await sleep(1_000);
  }
  if (existsSync(appExe) || existsSync(resources)) {
    fail("Uninstall left the application binaries behind");
  }
  assertExists(logFile, "Preserved session data (userData)");
  console.log(`Package smoke passed for ${arch}`);
};

await main();

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { CLI_RUNTIME_ENTRIES } from "../src/main/cli-installer";
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
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    },
  );
  if (result.status !== 0) {
    fail(`${executable} ${argLine} exited with ${result.status}`);
  }
};

const isRegistered = (key: string): boolean => {
  const result = spawnSync("reg", ["query", key], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
};

const assertRegistered = (key: string): void => {
  if (!isRegistered(key)) {
    fail(`Expected registry key is missing: ${key}`);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForVersionCommand = async (
  executable: string,
  label: string,
): Promise<void> => {
  let diagnostics = "not started";
  for (let waited = 0; waited < 60_000; waited += 2_000) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const output = result.stdout.trim();
    if (result.status === 0 && output) {
      if (waited > 0) {
        console.log(
          `${label} became runnable after ${waited / 2_000 + 1} attempts.`,
        );
      }
      return;
    }
    diagnostics = [
      `exit ${result.status ?? "not started"}`,
      result.signal ? `signal ${result.signal}` : null,
      result.error ? `spawn error: ${result.error.message}` : null,
      result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : null,
    ]
      .filter((detail): detail is string => detail !== null)
      .join("; ");
    await sleep(2_000);
  }
  fail(`${label} failed to execute (${diagnostics})`);
};

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
  for (const entry of CLI_RUNTIME_ENTRIES) {
    assertExists(
      path.join(resources, "cli-runtime", entry),
      `CLI runtime entry ${entry}`,
    );
  }
  for (const [relative, label] of [
    ["web-dist/index.html", "Web renderer bundle"],
    ["cli-runtime/runtime.json", "Runtime manifest"],
    [`native-helper/${arch}/Vellum.WindowsHelper.exe`, "Native helper"],
    ["preview-handler/Vellum.PreviewHandler.dll", "Preview handler DLL"],
    ["tray.ico", "Tray icon"],
  ] as const) {
    assertExists(path.join(resources, relative), label);
  }
  const packagedBun = path.join(resources, "cli-runtime", "bun.exe");
  await waitForVersionCommand(packagedBun, `Packaged Bun runtime for ${arch}`);
  const packagedCli = path.join(resources, "cli-runtime", "vellum.exe");
  await waitForVersionCommand(packagedCli, `Packaged CLI for ${arch}`);
  assertRegistered("HKCU\\Software\\Classes\\.vellum");

  console.log(`Launching ${appExe}`);
  const child = spawn(appExe, [], {
    stdio: "ignore",
    windowsHide: true,
  });
  const logCandidates = [productName, packageName].flatMap((name) => [
    path.join(appData, name, "logs", "vellum.log"),
    path.join(appData, `${name}-${env}`, "logs", "vellum.log"),
  ]);
  const protocolKey = `HKCU\\Software\\Classes\\${scheme}`;
  let logFile: string | undefined;
  for (let waited = 0; waited < 120_000; waited += 2_000) {
    await sleep(2_000);
    logFile ??= logCandidates.find((candidate) => existsSync(candidate));
    if (child.exitCode !== null) {
      fail(`App exited early with code ${child.exitCode}`);
    }
    if (logFile && isRegistered(protocolKey)) {
      break;
    }
  }
  if (!logFile) {
    fail(`App produced no log file at ${logCandidates.join(" or ")}`);
    return;
  }
  assertRegistered(protocolKey);
  console.log(`App is running with logs at ${logFile}`);
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "inherit",
    windowsHide: true,
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

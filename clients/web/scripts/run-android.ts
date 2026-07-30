import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const API_LEVEL = "36";
const BUILD_TOOLS_VERSION = "36.0.0";
const AVD_NAME = "vellum-api-36";
const IMAGE_TAG = "google_apis_playstore";
const IMAGE_ABI = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
const SYSTEM_IMAGE = `system-images;android-${API_LEVEL};${IMAGE_TAG};${IMAGE_ABI}`;

const webRoot = resolve(import.meta.dir, "..");
const androidRoot = resolve(webRoot, "../android");

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, pathValue = process.env.PATH): string | null {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  for (const directory of pathValue?.split(delimiter) ?? []) {
    const candidate = join(directory, executable);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    return null;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): void {
  console.log(`\n> ${basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: webRoot,
    env,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readLocalSdkPath(): string | null {
  const localProperties = join(androidRoot, "local.properties");
  if (!existsSync(localProperties)) {
    return null;
  }
  const match = readFileSync(localProperties, "utf8").match(/^sdk\.dir=(.+)$/m);
  return match?.[1]?.replaceAll("\\\\", "\\").replaceAll("\\:", ":") ?? null;
}

function resolveSdkRoot(): string {
  const defaults =
    process.platform === "darwin"
      ? [join(homedir(), "Library/Android/sdk")]
      : process.platform === "win32"
        ? [join(process.env.LOCALAPPDATA ?? homedir(), "Android/Sdk")]
        : [join(homedir(), "Android/Sdk")];
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    readLocalSdkPath(),
    ...defaults,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const existing = candidates.find((candidate) => existsSync(candidate));
  const sdkRoot = existing ?? candidates[0];
  if (!sdkRoot) {
    throw new Error("Could not determine the Android SDK location.");
  }
  mkdirSync(sdkRoot, { recursive: true });
  return sdkRoot;
}

function commandLineToolInSdk(sdkRoot: string, name: string): string | null {
  const executable = process.platform === "win32" ? `${name}.bat` : name;
  const commandLineRoot = join(sdkRoot, "cmdline-tools");
  const candidates = [join(commandLineRoot, "latest", "bin", executable)];
  if (existsSync(commandLineRoot)) {
    for (const version of readdirSync(commandLineRoot).sort().reverse()) {
      candidates.push(join(commandLineRoot, version, "bin", executable));
    }
  }
  return candidates.find((candidate) => candidate && isExecutable(candidate)) ?? null;
}

function commandLineTool(sdkRoot: string, name: string): string | null {
  return commandLineToolInSdk(sdkRoot, name) ?? findOnPath(name);
}

function requireHomebrew(env: NodeJS.ProcessEnv): string {
  const brew = findOnPath("brew", env.PATH);
  if (!brew) {
    throw new Error(
      "Android command-line tools are missing. Install them from the Android SDK Manager or install Homebrew.",
    );
  }
  return brew;
}

function resolveJavaHome(env: NodeJS.ProcessEnv): string | null {
  if (env.JAVA_HOME) {
    const version = capture(join(env.JAVA_HOME, "bin/java"), ["-version"], env);
    if (version?.includes('version "21.')) {
      return env.JAVA_HOME;
    }
  }
  if (process.platform === "darwin") {
    return capture("/usr/libexec/java_home", ["-v", "21"], env);
  }
  const java = findOnPath("java", env.PATH);
  const version = java ? capture(java, ["-version"], env) : null;
  return version?.includes('version "21.') && java ? dirname(dirname(java)) : null;
}

function ensureJava(env: NodeJS.ProcessEnv): void {
  let javaHome = resolveJavaHome(env);
  if (!javaHome && process.platform === "darwin") {
    const brew = requireHomebrew(env);
    console.log("Java 21 is missing. Installing Temurin 21 with Homebrew.");
    run(brew, ["install", "--cask", "temurin@21"], env);
    javaHome = resolveJavaHome(env);
  }
  if (!javaHome) {
    throw new Error("Java 21 is required to run the Android app.");
  }
  env.JAVA_HOME = javaHome;
  env.PATH = `${join(javaHome, "bin")}${delimiter}${env.PATH ?? ""}`;
}

function ensureCommandLineTools(
  sdkRoot: string,
  env: NodeJS.ProcessEnv,
): { sdkmanager: string; avdmanager: string } {
  let sdkmanager = commandLineTool(sdkRoot, "sdkmanager");
  let avdmanager = commandLineTool(sdkRoot, "avdmanager");
  if ((!sdkmanager || !avdmanager) && process.platform === "darwin") {
    const brew = requireHomebrew(env);
    console.log(
      "Android command-line tools are missing. Installing them with Homebrew.",
    );
    run(brew, ["install", "--cask", "android-commandlinetools"], env);
    sdkmanager = commandLineTool(sdkRoot, "sdkmanager");
    avdmanager = commandLineTool(sdkRoot, "avdmanager");
  }
  if (!sdkmanager || !avdmanager) {
    throw new Error(
      "Android SDK Command-line Tools are required to create an emulator.",
    );
  }

  let localSdkmanager = commandLineToolInSdk(sdkRoot, "sdkmanager");
  let localAvdmanager = commandLineToolInSdk(sdkRoot, "avdmanager");
  if (!localSdkmanager || !localAvdmanager) {
    console.log("Installing command-line tools into the Android SDK.");
    run(
      sdkmanager,
      [`--sdk_root=${sdkRoot}`, "cmdline-tools;latest"],
      env,
    );
    localSdkmanager = commandLineToolInSdk(sdkRoot, "sdkmanager");
    localAvdmanager = commandLineToolInSdk(sdkRoot, "avdmanager");
  }
  if (!localSdkmanager || !localAvdmanager) {
    throw new Error(
      `Android command-line tools were not installed under ${sdkRoot}.`,
    );
  }
  return { sdkmanager: localSdkmanager, avdmanager: localAvdmanager };
}

interface SdkPackage {
  name: string;
  path: string;
}

function ensureSdkPackages(
  sdkRoot: string,
  env: NodeJS.ProcessEnv,
  packages: SdkPackage[],
): void {
  const missing = packages.filter(({ path }) => !existsSync(path));
  if (missing.length === 0) {
    return;
  }

  const { sdkmanager } = ensureCommandLineTools(sdkRoot, env);
  console.log("Accept the Android SDK licenses to install missing packages.");
  run(sdkmanager, [`--sdk_root=${sdkRoot}`, "--licenses"], env);
  run(
    sdkmanager,
    [`--sdk_root=${sdkRoot}`, ...missing.map(({ name }) => name)],
    env,
  );

  const unavailable = missing.filter(({ path }) => !existsSync(path));
  if (unavailable.length > 0) {
    throw new Error(
      `Android SDK packages were not installed: ${unavailable.map(({ name }) => name).join(", ")}`,
    );
  }
}

function connectedDevices(adb: string, env: NodeJS.ProcessEnv): string[] {
  const output = capture(adb, ["devices"], env) ?? "";
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === "device")
    .map(([serial]) => serial);
}

function isDeviceBooted(
  adb: string,
  serial: string,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    capture(
      adb,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      env,
    ) === "1"
  );
}

function availableAvds(emulator: string, env: NodeJS.ProcessEnv): string[] {
  return (capture(emulator, ["-list-avds"], env) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function avdConfigPath(avdName: string, env: NodeJS.ProcessEnv): string {
  const avdHome =
    env.ANDROID_AVD_HOME ??
    join(env.ANDROID_USER_HOME ?? join(homedir(), ".android"), "avd");
  return join(avdHome, `${avdName}.avd`, "config.ini");
}

function enableAvdKeyboard(
  avdName: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const configPath = avdConfigPath(avdName, env);
  if (!existsSync(configPath)) {
    return false;
  }
  const config = readFileSync(configPath, "utf8");
  const updated = /^hw\.keyboard=/m.test(config)
    ? config.replace(/^hw\.keyboard=.*$/m, "hw.keyboard=yes")
    : `${config.trimEnd()}\nhw.keyboard=yes\n`;
  if (updated === config) {
    return false;
  }
  writeFileSync(configPath, updated);
  console.log(`Enabled keyboard input for Android emulator ${avdName}.`);
  return true;
}

function startEmulator(
  emulator: string,
  avdName: string,
  env: NodeJS.ProcessEnv,
): void {
  console.log(`Starting Android emulator ${avdName}.`);
  const child = spawn(emulator, ["-avd", avdName], {
    detached: true,
    env,
    stdio: "ignore",
  });
  child.unref();
}

async function waitForEmulator(
  adb: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const serial = connectedDevices(adb, env).find((device) =>
      device.startsWith("emulator-"),
    );
    if (serial) {
      const bootCompleted = capture(
        adb,
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        env,
      );
      if (bootCompleted === "1") {
        return serial;
      }
    }
    await Bun.sleep(2_000);
  }
  throw new Error("Android emulator did not finish booting within 3 minutes.");
}

async function waitForDeviceToStop(
  adb: string,
  serial: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!connectedDevices(adb, env).includes(serial)) {
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Android emulator ${serial} did not stop within 30 seconds.`);
}

async function waitForDeviceReadyOrStop(
  adb: string,
  serial: string,
  env: NodeJS.ProcessEnv,
): Promise<"ready" | "stopped"> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!connectedDevices(adb, env).includes(serial)) {
      return "stopped";
    }
    if (isDeviceBooted(adb, serial, env)) {
      return "ready";
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Android device ${serial} was not ready within 3 minutes.`);
}

function ensureAvd(sdkRoot: string, env: NodeJS.ProcessEnv): string {
  const emulator = join(
    sdkRoot,
    "emulator",
    process.platform === "win32" ? "emulator.exe" : "emulator",
  );
  const avds = availableAvds(emulator, env);
  if (avds.includes(AVD_NAME)) {
    enableAvdKeyboard(AVD_NAME, env);
    return AVD_NAME;
  }
  if (avds.length > 0) {
    enableAvdKeyboard(avds[0], env);
    return avds[0];
  }

  const { avdmanager } = ensureCommandLineTools(sdkRoot, env);
  console.log(`Creating Android emulator ${AVD_NAME}.`);
  run(
    avdmanager,
    [
      "create",
      "avd",
      "--force",
      "--name",
      AVD_NAME,
      "--package",
      SYSTEM_IMAGE,
    ],
    env,
    "no\n",
  );
  enableAvdKeyboard(AVD_NAME, env);
  return AVD_NAME;
}

async function main(): Promise<void> {
  const sdkRoot = resolveSdkRoot();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    VELLUM_ENVIRONMENT: "dev",
  };

  ensureJava(env);

  ensureSdkPackages(sdkRoot, env, [
    {
      name: "platform-tools",
      path: join(
        sdkRoot,
        "platform-tools",
        process.platform === "win32" ? "adb.exe" : "adb",
      ),
    },
    {
      name: `platforms;android-${API_LEVEL}`,
      path: join(sdkRoot, "platforms", `android-${API_LEVEL}`),
    },
    {
      name: `build-tools;${BUILD_TOOLS_VERSION}`,
      path: join(sdkRoot, "build-tools", BUILD_TOOLS_VERSION),
    },
  ]);

  env.PATH = [
    join(sdkRoot, "platform-tools"),
    join(sdkRoot, "emulator"),
    env.PATH ?? "",
  ].join(delimiter);

  const adb = join(
    sdkRoot,
    "platform-tools",
    process.platform === "win32" ? "adb.exe" : "adb",
  );
  const emulator = join(
    sdkRoot,
    "emulator",
    process.platform === "win32" ? "emulator.exe" : "emulator",
  );
  const keyboardUpdated = availableAvds(emulator, env).includes(AVD_NAME)
    ? enableAvdKeyboard(AVD_NAME, env)
    : false;
  let devices = connectedDevices(adb, env);
  const runningVellumEmulator = devices.find((serial) => {
    if (!serial.startsWith("emulator-")) {
      return false;
    }
    const runningAvd = capture(adb, ["-s", serial, "emu", "avd", "name"], env);
    return runningAvd?.split(/\r?\n/)[0] === AVD_NAME;
  });
  if (keyboardUpdated && runningVellumEmulator) {
    console.log(`Restarting ${AVD_NAME} to enable keyboard input.`);
    run(adb, ["-s", runningVellumEmulator, "emu", "kill"], env);
    await waitForDeviceToStop(adb, runningVellumEmulator, env);
    devices = connectedDevices(adb, env);
  }

  let deviceSerial = devices.find((serial) => isDeviceBooted(adb, serial, env));
  if (!deviceSerial && devices[0]) {
    const pendingSerial = devices[0];
    const state = await waitForDeviceReadyOrStop(adb, pendingSerial, env);
    if (state === "ready") {
      deviceSerial = pendingSerial;
    }
  }
  if (!deviceSerial) {
    ensureSdkPackages(sdkRoot, env, [
      {
        name: "emulator",
        path: join(
          sdkRoot,
          "emulator",
          process.platform === "win32" ? "emulator.exe" : "emulator",
        ),
      },
      {
        name: SYSTEM_IMAGE,
        path: join(
          sdkRoot,
          "system-images",
          `android-${API_LEVEL}`,
          IMAGE_TAG,
          IMAGE_ABI,
        ),
      },
    ]);
    const avdName = ensureAvd(sdkRoot, env);
    startEmulator(emulator, avdName, env);
    deviceSerial = await waitForEmulator(adb, env);
  }

  console.log(`Using Android target ${deviceSerial}.`);
  run(
    process.execPath,
    ["x", "--bun", "cap", "sync", "android"],
    env,
  );

  env.ANDROID_SERIAL = deviceSerial;
  run(
    adb,
    [
      "-s",
      deviceSerial,
      "shell",
      "settings",
      "put",
      "secure",
      "show_ime_with_hard_keyboard",
      "1",
    ],
    env,
  );
  run(
    join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    ["-p", androidRoot, ":app:installDevDebug"],
    env,
  );
  run(
    adb,
    [
      "-s",
      deviceSerial,
      "shell",
      "am",
      "start",
      "-n",
      "ai.vocify.vellumassistant.dev/ai.vocify.vellumassistant.MainActivity",
    ],
    env,
  );
  console.log(`Android app launched on ${deviceSerial}.`);
}

try {
  await main();
} catch (error) {
  console.error(
    `Android run failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

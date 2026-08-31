// @ts-check

const { spawnSync } = require("node:child_process");

const env = process.env.VELLUM_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch =
  process.env.ELECTRON_TARGET_ARCH ||
  (process.arch === "arm64" ? "arm64" : "x64");
const msbuildPlatform = targetArch === "arm64" ? "ARM64" : "x64";

const productName =
  env === "production"
    ? "Vellum"
    : `Vellum ${env.charAt(0).toUpperCase() + env.slice(1)}`;

const appId =
  env === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${env}`;

const schemes =
  env === "production"
    ? ["vellum", "vellum-assistant"]
    : [`vellum-assistant-${env}`];

const iconEnvironment = ["local", "dev", "staging", "production"].includes(env)
  ? env
  : "production";
const appIcon = `build-resources/icons/${iconEnvironment}/icon.ico`;

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for WINDOWS_SIGNING_PROVIDER=${process.env.WINDOWS_SIGNING_PROVIDER}`,
    );
  }
  return value;
};

// Signing is provider-neutral: the release workflow picks a provider through
// WINDOWS_SIGNING_PROVIDER and electron-builder signs every exe/dll/node in
// the app, the NSIS uninstaller, and the installer. Unset means unsigned
// (local packs and CI smoke).
const resolveSigning = () => {
  const provider = process.env.WINDOWS_SIGNING_PROVIDER;
  const timestampUrl =
    process.env.WINDOWS_SIGNING_TIMESTAMP_URL ||
    "http://timestamp.digicert.com";
  switch (provider || "") {
    case "":
      return {};
    // Certificate and password arrive through electron-builder's own
    // WIN_CSC_LINK (base64 PFX) and WIN_CSC_KEY_PASSWORD.
    case "pfx":
      return {
        signtoolOptions: {
          signingHashAlgorithms: ["sha256"],
          rfc3161TimeStampServer: timestampUrl,
        },
      };
    // Authenticates through AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
    case "azure-trusted-signing":
      return {
        azureSignOptions: {
          endpoint: requireEnv("AZURE_TRUSTED_SIGNING_ENDPOINT"),
          codeSigningAccountName: requireEnv("AZURE_TRUSTED_SIGNING_ACCOUNT"),
          certificateProfileName: requireEnv("AZURE_TRUSTED_SIGNING_PROFILE"),
          publisherName: requireEnv("WINDOWS_SIGNING_PUBLISHER_NAME"),
          timestampRfc3161: timestampUrl,
        },
      };
    // Any other signing CLI (DigiCert KeyLocker, AzureSignTool, ...): a shell
    // command with a {file} placeholder, run once per file. The publisher
    // name lands in app-update.yml so the updater verifies downloads.
    case "command": {
      const template = requireEnv("WINDOWS_SIGN_COMMAND");
      if (!template.includes("{file}")) {
        throw new Error(
          "WINDOWS_SIGN_COMMAND must contain a {file} placeholder",
        );
      }
      return {
        signtoolOptions: {
          publisherName: requireEnv("WINDOWS_SIGNING_PUBLISHER_NAME"),
          signingHashAlgorithms: ["sha256"],
          sign: async ({ path: file }) => {
            const command = template.replaceAll("{file}", `"${file}"`);
            const result = spawnSync(command, {
              shell: true,
              stdio: "inherit",
              windowsHide: true,
            });
            if (result.status !== 0) {
              throw new Error(
                `WINDOWS_SIGN_COMMAND failed for ${file} (exit ${result.status})`,
              );
            }
          },
        },
      };
    }
    default:
      throw new Error(`Unknown WINDOWS_SIGNING_PROVIDER: ${provider}`);
  }
};

const runBun = (args, label) => {
  const result = spawnSync("bun", args, {
    cwd: __dirname,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
};

// Enumerates every packaged executable and DLL (and later the installer)
// into dist/signing-manifest-<arch>.json for signature verification.
const enumerateSignableFiles = (args) =>
  runBun(["scripts/after-pack.ts", ...args], "after-pack enumeration");

const buildElectronEntrypoints = () =>
  runBun(["run", "build"], "Electron build");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  toolsets: {
    winCodeSign: "1.1.0",
  },
  publish: {
    provider: "generic",
    url: `https://storage.googleapis.com/vellum-ai-${bucketEnv}-releases/win-electron/${targetArch}/`,
  },
  directories: {
    output: "dist",
  },
  // Requires `bun run build:web` (resources/web-dist), `bun run build:runtime`
  // (resources/cli-runtime), `bun run build:native-helper` (resources/
  // native-helper/<arch>), and `bun run build:preview-handler` (native COM
  // build output) to exist before packing.
  extraResources: [
    { from: "resources/web-dist", to: "web-dist" },
    {
      from: `resources/native-helper/${targetArch}`,
      to: `native-helper/${targetArch}`,
    },
    { from: "resources/tray.ico", to: "tray.ico" },
    { from: appIcon, to: "icon.ico" },
    { from: "resources/cli-runtime", to: "cli-runtime" },
    // electron-builder excludes a node_modules directory encountered below a
    // broader file matcher. Use it as the matcher root so the CLI runtime's
    // native packages are included in the installed app.
    {
      from: "resources/cli-runtime/node_modules",
      to: "cli-runtime/node_modules",
    },
    {
      from: `native/Vellum.PreviewHandler/build/${msbuildPlatform}/Release`,
      to: "preview-handler",
      filter: ["Vellum.PreviewHandler.dll", "registration.json"],
    },
  ],
  win: {
    icon: appIcon,
    target: [
      {
        target: "nsis",
        arch: [targetArch],
      },
    ],
    // electron-builder signs only `.exe` by default; the CLI runtime, helper,
    // and preview-handler DLL must carry the same signature.
    signExts: [".exe", ".dll", ".node"],
    ...resolveSigning(),
  },
  nsis: {
    installerIcon: appIcon,
    uninstallerIcon: appIcon,
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
    shortcutName: productName,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Session data (userData) survives uninstall; the CLI launcher is
    // removed by scripts/installer.nsh.
    deleteAppDataOnUninstall: false,
    include: "scripts/installer.nsh",
  },
  protocols: [
    {
      name: "Vellum Deep Links",
      schemes,
    },
  ],
  fileAssociations: [
    {
      ext: "vellum",
      name: "Vellum Bundle",
    },
  ],
  beforePack: buildElectronEntrypoints,
  afterPack: async (context) => {
    enumerateSignableFiles([
      "--app-out-dir",
      context.appOutDir,
      "--arch",
      targetArch,
    ]);
  },
  // Signing rewrites the binaries, so the manifest hashes are taken again.
  afterSign: async (context) => {
    enumerateSignableFiles([
      "--app-out-dir",
      context.appOutDir,
      "--arch",
      targetArch,
    ]);
  },
  artifactBuildCompleted: async (artifact) => {
    if (artifact.file.endsWith(".exe")) {
      enumerateSignableFiles([
        "--arch",
        targetArch,
        "--installer",
        artifact.file,
      ]);
    }
  },
};

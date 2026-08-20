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

// Enumerates every packaged executable and DLL (and later the installer)
// into dist/signing-manifest-<arch>.json for signature verification.
const enumerateSignableFiles = (args) => {
  const result = spawnSync("bun", ["scripts/after-pack.ts", ...args], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`after-pack enumeration failed (exit ${result.status})`);
  }
};

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
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
    { from: `resources/native-helper/${targetArch}`, to: "native-helper" },
    { from: "resources/tray.ico", to: "tray.ico" },
    { from: "resources/cli-runtime", to: "cli-runtime" },
    {
      from: `resources/native-helper/${targetArch}`,
      to: `native-helper/${targetArch}`,
    },
    {
      from: `native/Vellum.PreviewHandler/build/${msbuildPlatform}/Release`,
      to: "preview-handler",
      filter: ["Vellum.PreviewHandler.dll", "registration.json"],
    },
  ],
  win: {
    target: [
      {
        target: "nsis",
        arch: [targetArch],
      },
    ],
  },
  nsis: {
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
  afterPack: async (context) => {
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

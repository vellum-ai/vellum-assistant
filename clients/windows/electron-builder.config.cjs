// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch =
  process.env.ELECTRON_TARGET_ARCH ||
  (process.arch === "arm64" ? "arm64" : "x64");

const productName =
  env === "production"
    ? "Vellum"
    : `Vellum ${env.charAt(0).toUpperCase() + env.slice(1)}`;

const appId =
  env === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${env}`;

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
  // Requires `bun run build:web` and `bun run build:native-helper` first so
  // resources/web-dist and resources/native-helper exist.
  extraResources: [
    { from: "resources/web-dist", to: "web-dist" },
    { from: `resources/native-helper/${targetArch}`, to: "native-helper" },
    { from: "resources/tray.ico", to: "tray.ico" },
    { from: "resources/cli-runtime", to: "cli-runtime" },
    {
      from: `resources/native-helper/${targetArch}`,
      to: `native-helper/${targetArch}`,
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
    allowToChangeInstallationDirectory: true,
    include: "scripts/installer.nsh",
  },
};

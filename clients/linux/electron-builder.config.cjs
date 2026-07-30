// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch = process.env.ELECTRON_TARGET_ARCH || "x64";

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
    url: `https://storage.googleapis.com/vellum-ai-${bucketEnv}-releases/linux-electron/${targetArch}/`,
  },
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    { from: "resources/web-dist", to: "web-dist" },
    { from: "resources/cli-lockfile", to: "cli-lockfile" },
    { from: "build/icon.png", to: "icon.png" },
  ],
  afterPack: "./scripts/afterPack.cjs",
  linux: {
    icon: "build/icon.png",
    category: "Utility",
    target: [
      {
        target: "AppImage",
        arch: [targetArch],
      }
    ],
    maintainer: "Vellum AI",
    vendor: "Vellum AI",
    executableName: "vellum-linux"
  }
};
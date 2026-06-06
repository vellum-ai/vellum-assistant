// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "production";

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
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    { from: "resources/web-dist", to: "web-dist" },
    { from: "build/icon.icns", to: "icon.icns" },
  ],
  afterPack: "./scripts/afterPack.js",
  protocols: [
    {
      name: "Vellum Deep Links",
      schemes: ["vellum", "vellum-assistant"],
    },
  ],
  fileAssociations: [
    {
      ext: "vellum",
      name: "Vellum Bundle",
      role: "Viewer",
    },
  ],
  mac: {
    icon: "build/icon.icns",
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    entitlements: "./scripts/entitlements/app.plist",
    entitlementsInherit: "./scripts/entitlements/inherit.plist",
    extendInfo: {
      NSUserNotificationAlertStyle: "alert",
    },
    target: [
      {
        target: "dmg",
        arch: ["arm64"],
      },
    ],
  },
};

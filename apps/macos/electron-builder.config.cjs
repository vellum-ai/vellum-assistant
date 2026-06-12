// @ts-check

const env = process.env.VELLUM_ENVIRONMENT || "local";
const bucketEnv = env === "production" ? "prod" : env;
const targetArch = process.env.ELECTRON_TARGET_ARCH || "arm64";

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

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  publish: {
    provider: "generic",
    url: `https://storage.googleapis.com/vellum-ai-${bucketEnv}-releases/mac-electron/${targetArch}/`,
  },
  directories: {
    output: "dist",
  },
  extraResources: [
    { from: "resources/bun", to: "bun" },
    {
      from: "resources/vellum-mac-helper.app",
      to: "bin/vellum-mac-helper.app",
    },
    { from: "resources/web-dist", to: "web-dist" },
    { from: "resources/cli-lockfile", to: "cli-lockfile" },
    { from: "build/icon.icns", to: "icon.icns" },
  ],
  afterPack: "./scripts/afterPack.js",
  afterSign: "./scripts/afterSign.js",
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
      CFBundleIconName: "AppIcon",
      NSMicrophoneUsageDescription:
        "Vellum uses the microphone to record voice input for chat.",
      NSCameraUsageDescription:
        "Vellum uses the camera to capture photos when you ask your assistant to use the camera.",
      NSSpeechRecognitionUsageDescription:
        "Vellum uses speech recognition to transcribe dictated voice input.",
      NSAppleEventsUsageDescription:
        "Vellum uses Automation to paste dictated voice input into the app you are using.",
      NSUserNotificationAlertStyle: "alert",
      // Register the .vellum UTI so Quick Look extensions can provide
      // thumbnails and previews for .vellum bundle files in Finder.
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: "com.vellum.app-bundle",
          UTTypeConformsTo: ["public.data", "public.content"],
          UTTypeDescription: "Vellum App Bundle",
          UTTypeTagSpecification: {
            "public.filename-extension": ["vellum"],
            "public.mime-type": "application/x-vellum",
          },
        },
      ],
    },
    target: [
      {
        target: "dmg",
        arch: [targetArch],
      },
      {
        target: "zip",
        arch: [targetArch],
      },
    ],
  },
};

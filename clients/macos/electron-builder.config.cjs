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

// Mirror build-mac-helper.sh's env→helper-bundle-name mapping so the packaged
// app's `bin/` directory has the same folder name as the helper the build
// script wrote to `resources/`. The runtime sidecar
// `.vellum-mac-helper.bundle-name` carries the same string, so the runtime
// resolves the .app folder from the sidecar rather than this mapping — but the
// sidecar only reaches the packaged app if electron-builder copies it into
// `bin/` alongside the bundle.
const helperBundleName =
  env === "production"
    ? "Vellum Helper"
    : `Vellum Helper ${env.charAt(0).toUpperCase() + env.slice(1)}`;

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
      from: `resources/${helperBundleName}.app`,
      to: `bin/${helperBundleName}.app`,
    },
    // Sidecar written by build-mac-helper.sh. The runtime reads this to
    // discover the .app folder name without duplicating the env→name
    // mapping in TS. Must stay alongside the bundle in `bin/` so a
    // packaged app can resolve it via process.resourcesPath.
    {
      from: "resources/.vellum-mac-helper.bundle-name",
      to: "bin/.vellum-mac-helper.bundle-name",
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
  dmg: {
    // Installer-style DMG: a single app icon sits under "Install Vellum /
    // Double click the icon below". The app moves itself to /Applications on
    // first launch (see src/main/move-to-applications.ts), so the DMG needs no
    // Applications alias and no drag step. The background (+ @2x) is rendered
    // by scripts/generate-dmg-background.sh during pack — keep its 540x420
    // canvas in sync with `window` below.
    title: "Install ${productName}",
    background: "build/dmg-background.png",
    contents: [{ x: 270, y: 232, type: "file" }],
    window: { width: 540, height: 420 },
    iconSize: 128,
    iconTextSize: 13,
    // lzfse compression (macOS 10.11+) for smaller output than default zlib.
    format: "ULFO",
  },
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
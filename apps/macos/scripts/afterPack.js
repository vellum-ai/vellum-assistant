// Codesign the bundled bun binary with JIT/network entitlements (macOS hardened runtime).
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const resourcesDir = path.join(
    appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
  );
  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY || "-";
  const timestamp = identity === "-" ? "" : " --timestamp";
  const executables = [
    {
      name: "bun",
      path: path.join(resourcesDir, "bun"),
      entitlements: path.join(__dirname, "entitlements", "bun.plist"),
    },
    {
      name: "hotkey-helper",
      path: path.join(resourcesDir, "hotkey-helper"),
      entitlements: path.join(__dirname, "entitlements", "inherit.plist"),
    },
  ];

  for (const executable of executables) {
    if (!fs.existsSync(executable.path)) {
      console.warn(`afterPack: ${executable.name} not found at ${executable.path}, skipping codesign`);
      continue;
    }

    console.log(`afterPack: codesigning ${executable.name} with identity="${identity}"`);
    execSync(
      `codesign --force --options runtime --sign "${identity}"${timestamp} --entitlements "${executable.entitlements}" "${executable.path}"`,
      { stdio: "inherit" }
    );
  }
};

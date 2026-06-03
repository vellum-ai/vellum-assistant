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
  const bunPath = path.join(
    appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
    "bun"
  );

  if (!fs.existsSync(bunPath)) {
    console.warn(`afterPack: bun binary not found at ${bunPath}, skipping codesign`);
    return;
  }

  const entitlements = path.join(__dirname, "entitlements", "bun.plist");
  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY || "-";
  const timestamp = identity === "-" ? "" : " --timestamp";

  console.log(`afterPack: codesigning bun binary with identity="${identity}"`);
  execSync(
    `codesign --force --options runtime --sign "${identity}"${timestamp} --entitlements "${entitlements}" "${bunPath}"`,
    { stdio: "inherit" }
  );
};

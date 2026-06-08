// afterSign hook for electron-builder (macOS only).
//
// electron-builder signs extraResources executables with entitlementsInherit.
// Re-sign special bundled executables after that pass, then re-sign the outer
// app so the final bundle seal covers the updated nested signatures.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterSign(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const appDir = path.join(appOutDir, `${productName}.app`);
  const resourcesDir = path.join(appDir, "Contents", "Resources");
  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY || "-";
  const timestampFlag = identity === "-" ? "" : " --timestamp";
  const entitlementsDir = path.join(__dirname, "entitlements");

  const executables = [
    {
      name: "bun",
      path: path.join(resourcesDir, "bun"),
      entitlements: path.join(entitlementsDir, "bun.plist"),
    },
    {
      name: "vellum-mac-helper",
      path: path.join(resourcesDir, "bin", "vellum-mac-helper"),
      entitlements: path.join(entitlementsDir, "helper.plist"),
    },
  ];

  for (const executable of executables) {
    if (!fs.existsSync(executable.path)) {
      console.warn(`afterSign: ${executable.name} not found at ${executable.path}, skipping codesign`);
      continue;
    }

    console.log(`afterSign: codesigning ${executable.name} with identity="${identity}"`);
    execSync(
      `codesign --force --options runtime --sign "${identity}"${timestampFlag} --entitlements "${executable.entitlements}" "${executable.path}"`,
      { stdio: "inherit" }
    );
  }

  console.log(`afterSign: re-signing ${productName}.app with identity="${identity}"`);
  execSync(
    `codesign --force --options runtime --sign "${identity}"${timestampFlag} --entitlements "${path.join(entitlementsDir, "app.plist")}" "${appDir}"`,
    { stdio: "inherit" }
  );
};

// afterPack hook for electron-builder (macOS only).
//
// Runs after files are packaged but before code signing. Handles:
//   1. Codesigning the bundled bun binary with JIT/network entitlements.
//   2. Compiling and embedding Quick Look extensions (.appex) for .vellum files.
//
// electron-builder skips signing Contents/PlugIns (intended for kexts but also
// affects app extensions — see https://github.com/electron-userland/electron-builder/issues/9627),
// so we sign each appex here before the outer app is signed.

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Quick Look extensions to compile from the legacy Swift client source.
// Each entry maps to clients/macos/<name>/ which contains a .swift file
// and Info.plist with the extension metadata.
const QL_EXTENSIONS = [
  {
    name: "VellumQLThumbnail",
    sourceFile: "ThumbnailProvider.swift",
    frameworks: ["QuickLookThumbnailing", "AppKit", "CoreGraphics"],
    bundleIdSuffix: "QLThumbnail",
  },
  {
    name: "VellumQLPreview",
    sourceFile: "PreviewProvider.swift",
    frameworks: ["QuickLookUI", "UniformTypeIdentifiers"],
    bundleIdSuffix: "QLPreview",
  },
];

/**
 * Build a Quick Look .appex bundle from Swift source.
 *
 * Creates the standard appex directory structure:
 *   <name>.appex/Contents/MacOS/<name>   (compiled binary)
 *   <name>.appex/Contents/Info.plist     (extension metadata)
 *
 * @param {object} ext - Extension descriptor from QL_EXTENSIONS.
 * @param {string} plugInsDir - Path to Contents/PlugIns/ in the app bundle.
 * @param {string} appBundleId - The containing app's CFBundleIdentifier.
 * @param {string} identity - Code signing identity.
 * @param {string} timestampFlag - Timestamp flag for codesign ("" or " --timestamp").
 * @returns {boolean} true if the extension was built successfully.
 */
function buildQLExtension(ext, plugInsDir, appBundleId, identity, timestampFlag) {
  // Resolve source directory relative to the repo root (two levels up from apps/macos/scripts/).
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const sourceDir = path.join(repoRoot, "clients", "macos", ext.name);

  if (!fs.existsSync(sourceDir)) {
    console.warn(`afterPack: ${ext.name} source not found at ${sourceDir}, skipping`);
    return false;
  }

  const appexDir = path.join(plugInsDir, `${ext.name}.appex`);
  const contentsDir = path.join(appexDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  fs.mkdirSync(macosDir, { recursive: true });

  // Compile the Swift extension as an appex binary.
  // App extensions use NSExtensionMain as the entry point (provided by Foundation).
  const frameworkFlags = ext.frameworks.map((f) => `-framework ${f}`).join(" ");
  const binaryPath = path.join(macosDir, ext.name);
  const sourceFile = path.join(sourceDir, ext.sourceFile);

  console.log(`afterPack: compiling ${ext.name}...`);
  try {
    execSync(
      [
        "xcrun swiftc",
        `-module-name ${ext.name}`,
        "-emit-executable",
        `-target arm64-apple-macosx15.0`,
        `-sdk "$(xcrun --show-sdk-path)"`,
        frameworkFlags,
        "-Xlinker -e -Xlinker _NSExtensionMain",
        `-o "${binaryPath}"`,
        `"${sourceFile}"`,
      ].join(" "),
      { stdio: "inherit" }
    );
  } catch (err) {
    console.error(`afterPack: failed to compile ${ext.name}: ${err.message}`);
    // Clean up partial build so an unsigned appex doesn't end up in the bundle.
    fs.rmSync(appexDir, { recursive: true, force: true });
    return false;
  }

  // Generate Info.plist with the correct bundle identifier.
  // The appex bundle ID must be prefixed with the containing app's bundle ID
  // (Apple requirement for app extensions).
  const templatePlist = path.join(sourceDir, "Info.plist");
  const destPlist = path.join(contentsDir, "Info.plist");

  if (!fs.existsSync(templatePlist)) {
    console.error(`afterPack: Info.plist not found at ${templatePlist}`);
    fs.rmSync(appexDir, { recursive: true, force: true });
    return false;
  }

  let plistContent = fs.readFileSync(templatePlist, "utf-8");
  // Replace the legacy bundle ID with one scoped to the Electron app.
  const legacyBundleId = `com.vellum.vellum-assistant.${ext.bundleIdSuffix}`;
  const electronBundleId = `${appBundleId}.${ext.bundleIdSuffix}`;
  plistContent = plistContent.replace(legacyBundleId, electronBundleId);
  fs.writeFileSync(destPlist, plistContent);

  // Sign the appex. Must happen before electron-builder signs the outer app.
  console.log(`afterPack: codesigning ${ext.name}.appex...`);
  try {
    execSync(
      `codesign --force --options runtime --sign "${identity}"${timestampFlag} "${appexDir}"`,
      { stdio: "inherit" }
    );
  } catch (err) {
    console.error(`afterPack: failed to sign ${ext.name}.appex: ${err.message}`);
    fs.rmSync(appexDir, { recursive: true, force: true });
    return false;
  }

  console.log(`afterPack: ${ext.name}.appex built and signed`);
  return true;
}

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const appDir = path.join(appOutDir, `${productName}.app`);
  const contentsDir = path.join(appDir, "Contents");
  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY || "-";
  const timestampFlag = identity === "-" ? "" : " --timestamp";

  // 1. Codesign bundled bun binary with JIT/network entitlements.
  const bunPath = path.join(contentsDir, "Resources", "bun");
  if (fs.existsSync(bunPath)) {
    const entitlements = path.join(__dirname, "entitlements", "bun.plist");
    console.log(`afterPack: codesigning bun binary with identity="${identity}"`);
    execSync(
      `codesign --force --options runtime --sign "${identity}"${timestampFlag} --entitlements "${entitlements}" "${bunPath}"`,
      { stdio: "inherit" }
    );
  } else {
    console.warn(`afterPack: bun binary not found at ${bunPath}, skipping codesign`);
  }

  // 2. Build and embed Quick Look extensions (.appex).
  const plugInsDir = path.join(contentsDir, "PlugIns");
  const appBundleId = packager.config.appId;

  for (const ext of QL_EXTENSIONS) {
    buildQLExtension(ext, plugInsDir, appBundleId, identity, timestampFlag);
  }
};

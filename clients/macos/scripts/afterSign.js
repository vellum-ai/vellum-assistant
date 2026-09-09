// afterSign hook for electron-builder (macOS only).
//
// electron-builder signs extraResources executables with entitlementsInherit.
// Re-sign special bundled executables after that pass, then re-sign the outer
// app so the final bundle seal covers the updated nested signatures.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Arch } = require("builder-util");
const { findIdentity } = require("app-builder-lib/out/codeSign/macCodeSign");

// `lipo -archs` names the x64 slice x86_64, and electron-builder.config.cjs
// only ever targets one of these two.
const NOTIFIER_SLICE = {
  arm64: "arm64",
  x64: "x86_64",
};

/**
 * The addon is compiled for one architecture, is looked up at runtime under
 * `bin/notifier/<process.arch>/`, and electron-builder packs whatever sits
 * under resources/notifier. An addon built for the other architecture would
 * ship an app that quietly falls back to plain notifications, so fail the
 * build instead.
 *
 * @param {{ name: string, path: string }} addon
 * @param {string | undefined} packagedArch
 */
function assertNotifierArch(addon, packagedArch) {
  const expected = packagedArch ? NOTIFIER_SLICE[packagedArch] : undefined;
  if (!expected) {
    throw new Error(
      `afterSign: cannot check ${addon.name} against packaged architecture "${packagedArch}"; the notifier addon supports ${Object.keys(NOTIFIER_SLICE).join(" and ")}`
    );
  }
  const remedy = `Rebuild it with ELECTRON_TARGET_ARCH=${packagedArch} bash scripts/build-notifier.sh.`;
  if (!addon.name.startsWith(`notifier/${packagedArch}/`)) {
    throw new Error(
      `afterSign: ${addon.name} is not under notifier/${packagedArch}/, so the runtime lookup by process.arch would miss it. ${remedy}`
    );
  }
  const slices = execFileSync("lipo", ["-archs", addon.path], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  if (!slices.includes(expected)) {
    throw new Error(
      `afterSign: ${addon.name} is built for ${slices.join(", ")}, but this build packages ${packagedArch}. ${remedy}`
    );
  }
}

function getConfiguredQualifier(options) {
  if (options.identity !== undefined) {
    return options.identity;
  }

  return process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY || undefined;
}

function getCertificateTypes(isDevelopment) {
  return isDevelopment
    ? ["Mac Developer", "Developer ID Application"]
    : ["Developer ID Application"];
}

async function resolveSigningIdentity(context) {
  const { arch, packager } = context;
  const options = packager.platformSpecificBuildOptions || {};
  const qualifier = getConfiguredQualifier(options);

  if (qualifier === null) {
    console.warn("afterSign: mac.identity is null, skipping nested re-signing");
    return null;
  }

  const codeSigningInfo = packager.codeSigningInfo
    ? await packager.codeSigningInfo.value
    : {};
  const keychainFile = codeSigningInfo?.keychainFile || null;
  const explicitType = options.type;
  const isDevelopment = (explicitType || "distribution") === "development";

  let identity = null;
  for (const certificateType of getCertificateTypes(isDevelopment)) {
    identity = await findIdentity(certificateType, qualifier, keychainFile);
    if (identity != null) {
      break;
    }
  }

  if (identity == null && !isDevelopment && explicitType !== "distribution") {
    identity = await findIdentity("Mac Developer", qualifier, keychainFile);
  }

  const fallBackToAdhoc =
    (arch === Arch.arm64 || arch === Arch.universal) &&
    !packager.forceCodeSigning;
  const noIdentity = !options.sign && identity == null;

  if (qualifier === "-" || (noIdentity && fallBackToAdhoc)) {
    return { name: "-", sign: "-", keychainFile };
  }

  if (identity == null) {
    throw new Error(
      "afterSign: unable to resolve the macOS signing identity that electron-builder used"
    );
  }

  return {
    name: identity.name,
    sign: identity.hash || identity.name,
    keychainFile,
  };
}

function codesign(targetPath, entitlements, identity) {
  const args = ["--force", "--options", "runtime", "--sign", identity.sign];

  if (identity.keychainFile) {
    args.push("--keychain", identity.keychainFile);
  }

  if (identity.sign !== "-") {
    args.push("--timestamp");
  }

  args.push("--entitlements", entitlements, targetPath);
  execFileSync("codesign", args, { stdio: "inherit" });
}

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterSign(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const { appOutDir, arch, packager } = context;
  const productName = packager.appInfo.productFilename;
  const appDir = path.join(appOutDir, `${productName}.app`);
  const resourcesDir = path.join(appDir, "Contents", "Resources");
  const binDir = path.join(resourcesDir, "bin");
  const identity = await resolveSigningIdentity(context);
  if (identity == null) {
    return;
  }
  const entitlementsDir = path.join(__dirname, "entitlements");

  // The helper bundle's folder name is per-env (e.g. "Vellum Helper",
  // "Vellum Helper Dev"). Discover it by reading the sidecar that
  // build-mac-helper.sh writes alongside the bundle; fall back to walking
  // the bin directory for any .app folder if the sidecar is missing.
  let helperAppName = null;
  const sidecarPath = path.join(binDir, ".vellum-mac-helper.bundle-name");
  if (fs.existsSync(sidecarPath)) {
    helperAppName = fs.readFileSync(sidecarPath, "utf8").trim();
  }
  if (!helperAppName) {
    try {
      const entries = fs.readdirSync(binDir, { withFileTypes: true });
      const discovered = entries.find(
        (entry) =>
          entry.isDirectory() &&
          entry.name.endsWith(".app") &&
          entry.name !== "vellum-mac-helper.app",
      );
      if (discovered) {
        helperAppName = discovered.name.replace(/\.app$/, "");
      }
    } catch {
      // fall through to the default `vellum-mac-helper.app` name
    }
  }
  const helperAppPath = helperAppName
    ? path.join(binDir, `${helperAppName}.app`)
    : path.join(binDir, "vellum-mac-helper.app");

  // The notifier addon is packed per architecture under bin/notifier/<arch>/,
  // so collect whatever architectures this build shipped.
  const notifierAddons = [];
  const packagedArch = Arch[arch];
  const notifierDir = path.join(binDir, "notifier");
  if (fs.existsSync(notifierDir)) {
    for (const archEntry of fs.readdirSync(notifierDir, {
      withFileTypes: true,
    })) {
      if (!archEntry.isDirectory()) {
        continue;
      }
      const archDir = path.join(notifierDir, archEntry.name);
      for (const file of fs.readdirSync(archDir)) {
        if (!file.endsWith(".node")) {
          continue;
        }
        const addon = {
          name: `notifier/${archEntry.name}/${file}`,
          path: path.join(archDir, file),
          entitlements: path.join(entitlementsDir, "inherit.plist"),
        };
        assertNotifierArch(addon, packagedArch);
        notifierAddons.push(addon);
      }
    }
  }

  const executables = [
    {
      name: "bun",
      path: path.join(resourcesDir, "bun"),
      entitlements: path.join(entitlementsDir, "bun.plist"),
    },
    {
      name: helperAppName ?? "vellum-mac-helper",
      path: helperAppPath,
      entitlements: path.join(entitlementsDir, "helper.plist"),
    },
    ...notifierAddons,
  ];

  for (const executable of executables) {
    if (!fs.existsSync(executable.path)) {
      console.warn(
        `afterSign: ${executable.name} not found at ${executable.path}, skipping codesign`
      );
      continue;
    }

    console.log(
      `afterSign: codesigning ${executable.name} with identity="${identity.name}"`
    );
    codesign(executable.path, executable.entitlements, identity);
  }

  console.log(
    `afterSign: re-signing ${productName}.app with identity="${identity.name}"`
  );
  // Read back the decision electron-builder.config.cjs already made, rather
  // than re-reading the environment: only a build configured with a
  // provisioning profile may carry the restricted Communication Notifications
  // entitlement, and this pass has to sign the same set electron-builder did.
  const macOptions = packager.platformSpecificBuildOptions || {};
  const appEntitlements = macOptions.provisioningProfile
    ? macOptions.entitlements
    : path.join(entitlementsDir, "app.plist");
  codesign(appDir, appEntitlements, identity);
};

exports.__resolveSigningIdentityForTesting = resolveSigningIdentity;

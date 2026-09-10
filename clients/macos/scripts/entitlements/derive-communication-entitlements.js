// @ts-check

// `com.apple.developer.usernotifications.communication` is a restricted
// entitlement: an app that declares it without an authorizing provisioning
// profile is killed at launch, so only a build with
// VELLUM_MAC_PROVISIONING_PROFILE set may carry it. That build signs with this
// derived plist, which is `app.plist` plus the one restricted key, so the
// canonical entitlement set lives in exactly one file.

const fs = require("fs");
const path = require("path");

const COMMUNICATION_KEY = "com.apple.developer.usernotifications.communication";

const BASE_PLIST_PATH = path.join(__dirname, "app.plist");
const DERIVED_PLIST_PATH = path.join(
  __dirname,
  "..",
  "..",
  "build",
  "entitlements",
  "app-communication.plist",
);

/**
 * @param {string} basePlistXml
 * @returns {string}
 */
function addCommunicationEntitlement(basePlistXml) {
  if (basePlistXml.includes(`<key>${COMMUNICATION_KEY}</key>`)) {
    throw new Error(
      `${COMMUNICATION_KEY} is already in the base entitlements, so every build would carry the restricted key`,
    );
  }
  // The root dict is the outermost element, so its close is the last one.
  const closeIndex = basePlistXml.lastIndexOf("</dict>");
  if (closeIndex === -1) {
    throw new Error("Base entitlements have no <dict> to extend");
  }
  const indentMatch = /\n([ \t]*)<key>/.exec(basePlistXml);
  const indent = indentMatch ? indentMatch[1] : "    ";
  const insertion = `${indent}<key>${COMMUNICATION_KEY}</key>\n${indent}<true/>\n`;
  return (
    basePlistXml.slice(0, closeIndex) +
    insertion +
    basePlistXml.slice(closeIndex)
  );
}

/**
 * Writes the derived plist and returns its absolute path.
 *
 * @param {{ basePlistPath?: string, outputPath?: string }} [options]
 * @returns {string}
 */
function deriveCommunicationEntitlements(options = {}) {
  const basePlistPath = options.basePlistPath ?? BASE_PLIST_PATH;
  const outputPath = options.outputPath ?? DERIVED_PLIST_PATH;
  const derived = addCommunicationEntitlement(
    fs.readFileSync(basePlistPath, "utf8"),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, derived);
  return outputPath;
}

module.exports = {
  COMMUNICATION_KEY,
  BASE_PLIST_PATH,
  addCommunicationEntitlement,
  deriveCommunicationEntitlements,
};

const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  COMMUNICATION_KEY,
  BASE_PLIST_PATH,
  addCommunicationEntitlement,
  deriveCommunicationEntitlements,
} = require("./derive-communication-entitlements.js");

const basePlist = fs.readFileSync(BASE_PLIST_PATH, "utf8");
const INSERTION = `    <key>${COMMUNICATION_KEY}</key>\n    <true/>\n`;

// Every tag in an entitlements plist is either paired or self-closing, so a
// stack walk is enough to prove the derived document is well formed.
function assertWellFormedXml(xml) {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tagPattern = /<(\/?)([A-Za-z][\w.:-]*)([^>]*?)(\/?)>/g;
  const stack = [];
  let match = tagPattern.exec(body);
  while (match !== null) {
    const [, closing, name, , selfClosing] = match;
    if (!selfClosing) {
      if (closing) {
        expect(stack.pop()).toBe(name);
      } else {
        stack.push(name);
      }
    }
    match = tagPattern.exec(body);
  }
  expect(stack).toEqual([]);
}

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-entitlements-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("addCommunicationEntitlement", () => {
  test("is the base plist plus exactly one added key", () => {
    const derived = addCommunicationEntitlement(basePlist);

    expect(derived).toContain(INSERTION);
    expect(derived.replace(INSERTION, "")).toBe(basePlist);
    expect((derived.match(/<key>/g) ?? []).length).toBe(
      (basePlist.match(/<key>/g) ?? []).length + 1,
    );
  });

  test("produces valid XML", () => {
    assertWellFormedXml(basePlist);
    assertWellFormedXml(addCommunicationEntitlement(basePlist));
  });

  test("refuses a base plist that already declares the restricted key", () => {
    expect(() =>
      addCommunicationEntitlement(addCommunicationEntitlement(basePlist)),
    ).toThrow(/already in the base entitlements/);
  });
});

describe("deriveCommunicationEntitlements", () => {
  test("writes the derived plist under a directory it creates", () => {
    const outputPath = path.join(
      tempDir(),
      "entitlements",
      "app-communication.plist",
    );

    const written = deriveCommunicationEntitlements({ outputPath });

    expect(written).toBe(outputPath);
    const contents = fs.readFileSync(outputPath, "utf8");
    expect(contents).toBe(addCommunicationEntitlement(basePlist));
    assertWellFormedXml(contents);
  });

  test("picks up a new entitlement added to the base plist", () => {
    const dir = tempDir();
    const basePlistPath = path.join(dir, "app.plist");
    const outputPath = path.join(dir, "app-communication.plist");
    fs.writeFileSync(
      basePlistPath,
      basePlist.replace(
        "</dict>",
        "    <key>com.apple.security.personal-information.location</key>\n    <true/>\n</dict>",
      ),
    );

    deriveCommunicationEntitlements({ basePlistPath, outputPath });

    const contents = fs.readFileSync(outputPath, "utf8");
    expect(contents).toContain(
      "<key>com.apple.security.personal-information.location</key>",
    );
    expect(contents).toContain(`<key>${COMMUNICATION_KEY}</key>`);
  });
});

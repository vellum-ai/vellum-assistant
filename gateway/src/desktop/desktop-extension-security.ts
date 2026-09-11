import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getGatewaySecurityDir } from "../paths.js";
import { packageDesktopExtension } from "./desktop-extension-package.js";

export class DesktopExtensionSecurity {
  constructor(private readonly securityDir = getGatewaySecurityDir) {}

  provision(zip: Buffer): { id: string; crx: string; token: string } {
    const root = join(this.securityDir(), "desktop-extension");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const keyPath = join(root, "signing.pem");
    let pem: Buffer;
    try {
      pem = readFileSync(keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      const generated = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      }).privateKey.export({ type: "pkcs8", format: "pem" });
      const staging = `${keyPath}.${randomBytes(8).toString("hex")}`;
      try {
        writeFileSync(staging, generated, { mode: 0o600, flag: "wx" });
        try {
          linkSync(staging, keyPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
        }
      } finally {
        rmSync(staging, { force: true });
      }
      pem = readFileSync(keyPath);
    }
    const signed = packageDesktopExtension(zip, createPrivateKey(pem));
    const token = randomBytes(32).toString("hex");
    const capabilityPath = join(root, "capability.sha256");
    const staging = `${capabilityPath}.${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(staging, createHash("sha256").update(token).digest(), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(staging, capabilityPath);
    } finally {
      rmSync(staging, { force: true });
    }
    return { id: signed.id, crx: signed.crx.toString("base64"), token };
  }

  accepts(token: unknown): boolean {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      return false;
    }
    try {
      const expected = readFileSync(
        join(this.securityDir(), "desktop-extension", "capability.sha256"),
      );
      const actual = createHash("sha256").update(token).digest();
      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    } catch {
      return false;
    }
  }
}

export const desktopExtensionSecurity = new DesktopExtensionSecurity();

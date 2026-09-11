import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DesktopExtensionSecurity } from "../desktop/desktop-extension-security.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "desktop-security-"));
  roots.push(root);
  return { root, create: () => new DesktopExtensionSecurity(() => root) };
}

test("replacement gateways preserve the extension identity and rotate native capabilities", () => {
  const f = fixture();
  const first = f.create().provision(Buffer.from("example extension zip"));
  const replacement = f.create();
  expect(replacement.accepts(first.token)).toBe(true);
  const next = replacement.provision(Buffer.from("updated extension zip"));
  expect(next.id).toBe(first.id);
  expect(replacement.accepts(first.token)).toBe(false);
  expect(f.create().accepts(next.token)).toBe(true);
  expect(replacement.accepts("0".repeat(64))).toBe(false);
  expect(Buffer.from(next.crx, "base64").subarray(0, 4).toString()).toBe(
    "Cr24",
  );
  expect(Object.keys(next).sort()).toEqual(["crx", "id", "token"]);
  expect(
    statSync(join(f.root, "desktop-extension", "signing.pem")).mode & 0o777,
  ).toBe(0o600);
  expect(
    readFileSync(
      join(f.root, "desktop-extension", "capability.sha256"),
    ).toString(),
  ).not.toContain(next.token);
});

test("missing capability state and corrupt signing keys fail closed", () => {
  const f = fixture();
  const security = f.create();
  expect(security.accepts("0".repeat(64))).toBe(false);
  const first = security.provision(Buffer.from("example zip"));
  const keyPath = join(f.root, "desktop-extension", "signing.pem");
  writeFileSync(keyPath, "corrupt");
  expect(() => security.provision(Buffer.from("updated zip"))).toThrow();
  expect(readFileSync(keyPath, "utf8")).toBe("corrupt");
  expect(security.accepts(first.token)).toBe(true);
});

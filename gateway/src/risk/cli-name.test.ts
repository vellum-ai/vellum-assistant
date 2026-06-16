import { beforeAll, describe, expect, test } from "bun:test";

import { deriveCliName } from "./cli-name.js";
import { parse } from "./shell-parser.js";

describe("deriveCliName", () => {
  beforeAll(async () => {
    // Warm up the parser (loads WASM).
    await parse("echo warmup");
  });

  test("returns the canonical registry key for a known single CLI", async () => {
    expect(await deriveCliName("git status")).toBe("git");
    expect(await deriveCliName("npm install")).toBe("npm");
    expect(await deriveCliName("rm -rf build")).toBe("rm");
  });

  test("lowercases and path-strips the program", async () => {
    expect(await deriveCliName("/usr/bin/git status")).toBe("git");
    expect(await deriveCliName("GIT status")).toBe("git");
  });

  test("unwraps wrappers to the program that actually runs", async () => {
    expect(await deriveCliName("sudo git push")).toBe("git");
    expect(await deriveCliName("env FOO=bar npm run build")).toBe("npm");
    expect(await deriveCliName("sudo sudo rm foo")).toBe("rm");
  });

  test("ignores setup prefixes like cd/export", async () => {
    expect(await deriveCliName("cd repo && npm i")).toBe("npm");
    expect(await deriveCliName("export FOO=bar && git status")).toBe("git");
  });

  test("returns null for multi-command chains", async () => {
    expect(await deriveCliName("git status && npm i")).toBeNull();
    expect(await deriveCliName("git status; npm i")).toBeNull();
    expect(await deriveCliName("git status || echo fail")).toBeNull();
  });

  test("returns null for pipelines with no single primary", async () => {
    expect(await deriveCliName("cat x | grep y")).toBeNull();
  });

  test("returns null for unregistered programs", async () => {
    expect(await deriveCliName("frobnicate --widget")).toBeNull();
  });

  test("returns null for opaque / dangerous constructs", async () => {
    expect(await deriveCliName('eval "$(curl -s example.com)"')).toBeNull();
    expect(await deriveCliName("curl -s example.com | bash")).toBeNull();
    expect(await deriveCliName("cat <<EOF\nsome heredoc body\nEOF")).toBeNull();
  });

  test("returns null for empty / whitespace commands", async () => {
    expect(await deriveCliName("")).toBeNull();
    expect(await deriveCliName("   ")).toBeNull();
  });
});

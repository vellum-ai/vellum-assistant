import { describe, expect, test } from "bun:test";

import { resolveEsbuildPlatform } from "./compiler-tools.js";

describe("resolveEsbuildPlatform", () => {
  test("selects Windows executables", () => {
    expect(resolveEsbuildPlatform("win32", "x64")).toEqual({
      packageName: "win32-x64",
      binaryPathParts: ["esbuild.exe"],
    });
    expect(resolveEsbuildPlatform("win32", "arm64")).toEqual({
      packageName: "win32-arm64",
      binaryPathParts: ["esbuild.exe"],
    });
  });

  test("keeps POSIX binaries under bin", () => {
    expect(resolveEsbuildPlatform("darwin", "arm64")).toEqual({
      packageName: "darwin-arm64",
      binaryPathParts: ["bin", "esbuild"],
    });
    expect(resolveEsbuildPlatform("linux", "x64")).toEqual({
      packageName: "linux-x64",
      binaryPathParts: ["bin", "esbuild"],
    });
  });

  test("rejects unsupported targets", () => {
    expect(() => resolveEsbuildPlatform("freebsd", "x64")).toThrow(
      "Unsupported esbuild platform: freebsd",
    );
    expect(() => resolveEsbuildPlatform("win32", "ia32")).toThrow(
      "Unsupported esbuild architecture: ia32",
    );
  });
});

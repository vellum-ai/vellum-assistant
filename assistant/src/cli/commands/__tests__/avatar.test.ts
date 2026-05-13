/**
 * Tests for the `assistant avatar` CLI command.
 *
 * Validates:
 *   - Subcommand registration (generate, set, remove, get, character update,
 *     character components, character ascii)
 *   - Each subcommand calls cliIpcCall with the correct method and params
 *   - Path resolution for `set --image` (absolute vs relative)
 *   - Default values (get --format defaults to "path", ascii --width defaults to "60")
 *   - Exit codes on IPC failures
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: { ok: true } };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
    return undefined as never;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerAvatarCommand } = await import("../avatar.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerAvatarCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { ok: true } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers generate, set, remove, get, character subcommands under avatar", () => {
    const program = new Command();
    registerAvatarCommand(program);
    const avatar = program.commands.find((c) => c.name() === "avatar");
    expect(avatar).toBeDefined();
    const subcommandNames = avatar!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toContain("generate");
    expect(subcommandNames).toContain("set");
    expect(subcommandNames).toContain("remove");
    expect(subcommandNames).toContain("get");
    expect(subcommandNames).toContain("character");
  });

  test("registers update, components, ascii under character subgroup", () => {
    const program = new Command();
    registerAvatarCommand(program);
    const avatar = program.commands.find((c) => c.name() === "avatar");
    const character = avatar!.commands.find((c) => c.name() === "character");
    expect(character).toBeDefined();
    const subcommandNames = character!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toContain("ascii");
    expect(subcommandNames).toContain("components");
    expect(subcommandNames).toContain("update");
  });
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe("avatar generate", () => {
  test("calls avatar_generate with description", async () => {
    mockIpcResult = { ok: true, result: { ok: true, message: "Avatar generated successfully." } };

    const { exitCode } = await runCommand([
      "avatar",
      "generate",
      "--description",
      "blue cat",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_generate");
    expect(lastIpcCall!.params).toEqual({ body: { description: "blue cat" } });
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Service unavailable" };

    const { exitCode } = await runCommand([
      "avatar",
      "generate",
      "--description",
      "blue cat",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

describe("avatar set", () => {
  test("calls avatar_set with absolute imagePath unchanged", async () => {
    mockIpcResult = { ok: true, result: { ok: true } };

    const { exitCode } = await runCommand([
      "avatar",
      "set",
      "--image",
      "/tmp",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_set");
    expect(lastIpcCall!.params).toEqual({ body: { imagePath: "/tmp" } });
  });

  test("resolves relative path to absolute before calling avatar_set", async () => {
    mockIpcResult = { ok: true, result: { ok: true } };

    // avatar.ts resolves relative paths against VELLUM_WORKSPACE_DIR.
    // Point the workspace root at cwd so a real file (./package.json) is reachable.
    const originalWsDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = process.cwd();
    try {
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");

      const relPath = "./package.json";
      const resolved = resolve(process.cwd(), relPath);

      if (existsSync(resolved)) {
        await runCommand(["avatar", "set", "--image", relPath]);

        expect(lastIpcCall).toBeDefined();
        expect(lastIpcCall!.method).toBe("avatar_set");
        // Path should be absolute
        expect(((lastIpcCall!.params!.body as Record<string, unknown>).imagePath as string).startsWith("/")).toBe(true);
      }
      // If the file doesn't exist we skip — the test is about path resolution
    } finally {
      if (originalWsDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWsDir;
      }
    }
  });

  test("exits 1 if image file not found (no IPC call)", async () => {
    const { exitCode } = await runCommand([
      "avatar",
      "set",
      "--image",
      "/nonexistent/path/no-such-file.png",
    ]);

    expect(exitCode).toBe(1);
    // No IPC call should be made for missing file
    expect(lastIpcCall).toBeNull();
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Daemon error" };

    // Use /tmp which always exists
    const { existsSync } = await import("node:fs");
    const tmpFile = "/tmp";
    if (existsSync(tmpFile)) {
      const { exitCode } = await runCommand([
        "avatar",
        "set",
        "--image",
        tmpFile,
      ]);
      expect(exitCode).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("avatar remove", () => {
  test("calls avatar_remove and reports no avatar when hadAvatar is false", async () => {
    mockIpcResult = { ok: true, result: { ok: true, hadAvatar: false } };

    const { exitCode } = await runCommand(["avatar", "remove"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_remove");
  });

  test("calls avatar_remove and reports removed when hadAvatar is true", async () => {
    mockIpcResult = { ok: true, result: { ok: true, hadAvatar: true } };

    const { exitCode } = await runCommand(["avatar", "remove"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_remove");
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Daemon not running" };

    const { exitCode } = await runCommand(["avatar", "remove"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("avatar get", () => {
  test("calls avatar_get with default format path", async () => {
    mockIpcResult = {
      ok: true,
      result: { exists: true, path: "/home/user/.vellum/workspace/data/avatar/avatar-image.png" },
    };

    const { exitCode } = await runCommand(["avatar", "get"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_get");
    expect(lastIpcCall!.params).toEqual({ body: { format: "path" } });
  });

  test("calls avatar_get with format base64", async () => {
    mockIpcResult = {
      ok: true,
      result: { exists: true, base64: "abc123==" },
    };

    const { exitCode } = await runCommand([
      "avatar",
      "get",
      "--format",
      "base64",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_get");
    expect(lastIpcCall!.params).toEqual({ body: { format: "base64" } });
  });

  test("exits 1 for invalid format (no IPC call)", async () => {
    const { exitCode } = await runCommand([
      "avatar",
      "get",
      "--format",
      "invalid",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("prints nothing when avatar does not exist", async () => {
    mockIpcResult = { ok: true, result: { exists: false } };

    const { exitCode } = await runCommand(["avatar", "get"]);

    expect(exitCode).toBe(0);
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "IPC timeout" };

    const { exitCode } = await runCommand(["avatar", "get"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// character update
// ---------------------------------------------------------------------------

describe("avatar character update", () => {
  test("calls avatar_render_from_traits with bodyShape, eyeStyle, color", async () => {
    mockIpcResult = { ok: true, result: { ok: true } };

    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "update",
      "--body-shape",
      "blob",
      "--eye-style",
      "curious",
      "--color",
      "green",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_render_from_traits");
    expect(lastIpcCall!.params).toEqual({
      body: {
        bodyShape: "blob",
        eyeStyle: "curious",
        color: "green",
      },
    });
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Invalid traits" };

    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "update",
      "--body-shape",
      "blob",
      "--eye-style",
      "curious",
      "--color",
      "green",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// character components
// ---------------------------------------------------------------------------

describe("avatar character components", () => {
  test("calls avatar_character_components", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        bodyShapes: [{ id: "blob" }],
        eyeStyles: [{ id: "curious" }],
        colors: [{ id: "green", hex: "#00ff00" }],
      },
    };

    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "components",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_character_components");
  });

  test("outputs JSON with --json flag", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        bodyShapes: [{ id: "blob" }],
        eyeStyles: [{ id: "curious" }],
        colors: [{ id: "green", hex: "#00ff00" }],
      },
    };

    const { exitCode, stdout } = await runCommand([
      "avatar",
      "character",
      "components",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.bodyShapes).toBeDefined();
    expect(Array.isArray(parsed.bodyShapes)).toBe(true);
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "Daemon error" };

    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "components",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// character ascii
// ---------------------------------------------------------------------------

describe("avatar character ascii", () => {
  test("calls avatar_character_ascii with default width 60", async () => {
    mockIpcResult = { ok: true, result: { ascii: "  o  \n /|\\ \n / \\ \n" } };

    const { exitCode } = await runCommand(["avatar", "character", "ascii"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_character_ascii");
    expect(lastIpcCall!.params).toEqual({ body: { width: "60" } });
  });

  test("calls avatar_character_ascii with custom width 40", async () => {
    mockIpcResult = { ok: true, result: { ascii: "  o  \n" } };

    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "ascii",
      "--width",
      "40",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("avatar_character_ascii");
    expect(lastIpcCall!.params).toEqual({ body: { width: "40" } });
  });

  test("exits 1 for non-numeric width (no IPC call)", async () => {
    const { exitCode } = await runCommand([
      "avatar",
      "character",
      "ascii",
      "--width",
      "abc",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("exits 1 on IPC error", async () => {
    mockIpcResult = { ok: false, error: "No character traits found" };

    const { exitCode } = await runCommand(["avatar", "character", "ascii"]);

    expect(exitCode).toBe(1);
  });
});

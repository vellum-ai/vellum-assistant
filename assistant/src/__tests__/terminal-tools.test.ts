import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mock modules ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, _prop: string) => () => {},
    }),
}));

const testTmpDir = process.env.VELLUM_WORKSPACE_DIR!;

const proxyGetOrStartSession = mock(() =>
  Promise.resolve({
    session: { id: "mock-session" },
  }),
);
const proxyGetSessionEnv = mock(() => ({
  HTTP_PROXY: "http://localhost:9999",
  HTTPS_PROXY: "http://localhost:9999",
}));

mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: proxyGetOrStartSession,
  getSessionEnv: proxyGetSessionEnv,
  createSession: () => {},
  startSession: () => {},
  stopSession: () => {},
  getActiveSession: () => null,
  getSessionsForConversation: () => [],
  stopAllSessions: () => {},
  ensureLocalCA: () => {},
  ensureCombinedCABundle: () => {},
  issueLeafCert: () => {},
  getCAPath: () => "",
  getCombinedCAPath: () => "",
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { formatShellOutput } from "../tools/shared/shell-output.js";
import {
  ALWAYS_INJECTED_ENV_VARS,
  buildSanitizedEnv,
  KATA_INJECTED_ENV_VARS,
  KATA_SAFE_ENV_VARS,
  SAFE_ENV_VARS,
} from "../tools/terminal/safe-env.js";
import { shellTool } from "../tools/terminal/shell.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Safe Environment — buildSanitizedEnv()
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSanitizedEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("passes through safe variables when present", () => {
    process.env.HOME = "/home/testuser";
    process.env.PATH = "/usr/bin";
    process.env.TERM = "xterm-256color";

    const env = buildSanitizedEnv();
    expect(env.HOME).toBe("/home/testuser");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM).toBe("xterm-256color");
  });

  test("strips non-allowlisted variables", () => {
    // Set some variables that are NOT on the safe list
    const unsafeKeys = ["MY_CUSTOM_KEY", "SOME_TOKEN", "DB_CONNECTION"];
    for (const key of unsafeKeys) {
      process.env[key] = "test-value";
    }

    const env = buildSanitizedEnv();
    for (const key of unsafeKeys) {
      expect(key in env).toBe(false);
      delete process.env[key];
    }
  });

  test("omits undefined safe variables", () => {
    delete process.env.GPG_TTY;
    delete process.env.SSH_AGENT_PID;
    delete process.env.DISPLAY;

    const env = buildSanitizedEnv();
    expect("GPG_TTY" in env).toBe(false);
    expect("SSH_AGENT_PID" in env).toBe(false);
    expect("DISPLAY" in env).toBe(false);
  });

  test("includes SSH_AUTH_SOCK when present", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    const env = buildSanitizedEnv();
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
  });

  test("includes locale variables", () => {
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "C";
    process.env.LC_CTYPE = "UTF-8";

    const env = buildSanitizedEnv();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("C");
    expect(env.LC_CTYPE).toBe("UTF-8");
  });

  test("only includes Kata apt variables for Kata-family sandbox runtimes", () => {
    process.env.VELLUM_SANDBOX_RUNTIME = "gvisor";
    process.env.PATH = "/usr/bin";
    process.env.VELLUM_APT_DATA_ROOT = "/data/system";
    process.env.LD_LIBRARY_PATH = "/host/lib";

    let env = buildSanitizedEnv();
    expect(env.VELLUM_APT_DATA_ROOT).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.PATH.split(":")).not.toContain("/data/system/usr/bin");

    process.env.VELLUM_SANDBOX_RUNTIME = "kata";
    env = buildSanitizedEnv();
    expect(env.VELLUM_APT_DATA_ROOT).toBe("/data/system");
    expect(env.PATH.split(":")).toContain("/data/system/usr/bin");
    expect(env.PATH.split(":")).toContain("/data/system/usr/local/bin");
    expect(env.LD_LIBRARY_PATH.split(":")).toContain("/data/system/usr/lib");
    expect(env.LD_LIBRARY_PATH.split(":")).toContain(
      "/data/system/usr/local/lib",
    );
    expect(env.LD_LIBRARY_PATH.split(":")).not.toContain("/host/lib");

    process.env.VELLUM_SANDBOX_RUNTIME = "cloud-hypervisor";
    env = buildSanitizedEnv();
    expect(env.VELLUM_APT_DATA_ROOT).toBe("/data/system");
    expect(env.PATH.split(":")).toContain("/data/system/usr/bin");
  });

  test("defaults LANG and LC_ALL to UTF-8 when unset", () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;

    const env = buildSanitizedEnv();
    const expectedLocale =
      process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
    expect(env.LANG).toBe(expectedLocale);
    expect(env.LC_ALL).toBe(expectedLocale);
  });

  test("injects INTERNAL_GATEWAY_BASE_URL from gateway config", () => {
    process.env.GATEWAY_PORT = "9000";
    const env = buildSanitizedEnv();
    expect(env.INTERNAL_GATEWAY_BASE_URL).toBe("http://127.0.0.1:9000");
    delete process.env.GATEWAY_PORT;
  });

  test("Kata entrypoint initializes apt root without inheriting apt loader paths", () => {
    const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");

    expect(entrypoint).toContain("/app/assistant/docker-init-apt-root.sh");
    expect(entrypoint).not.toContain(". /app/assistant/docker-kata-apt-env.sh");
  });

  test("result is a plain object with no prototype-inherited secrets", () => {
    const env = buildSanitizedEnv();
    const keys = Object.keys(env);
    const safeKeys: string[] = [
      ...SAFE_ENV_VARS,
      ...KATA_SAFE_ENV_VARS,
      ...KATA_INJECTED_ENV_VARS,
      ...ALWAYS_INJECTED_ENV_VARS,
    ];
    for (const key of keys) {
      expect(safeKeys).toContain(key);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Shell tool — input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Shell tool input validation", () => {
  const baseContext = {
    workingDir: testTmpDir,
    conversationId: "test-conv-1",
    trustClass: "guardian" as const,
    onOutput: () => {},
  };

  test("rejects empty command", async () => {
    const result = await shellTool.execute(
      { command: "", reason: "test" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  test("rejects non-string command", async () => {
    const result = await shellTool.execute(
      { command: 123, reason: "test" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  test("rejects command with null bytes", async () => {
    const result = await shellTool.execute(
      { command: "echo hello\0world", reason: "test" },
      baseContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("null bytes");
  });

  test("rejects missing command", async () => {
    const result = await shellTool.execute({ reason: "test" }, baseContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  test("executes simple command successfully", async () => {
    const result = await shellTool.execute(
      { command: "echo test_output_12345", reason: "testing" },
      baseContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("test_output_12345");
  });

  test("returns error for failed command", async () => {
    const result = await shellTool.execute(
      { command: "false", reason: "testing failure" },
      baseContext,
    );
    expect(result.isError).toBe(true);
  });

  test("default network mode is off", async () => {
    // When network_mode is not specified, it should default to 'off'.
    // Verify by checking that the proxy session is never started — the
    // observable effect of network_mode defaulting to 'off'.
    proxyGetOrStartSession.mockClear();
    const result = await shellTool.execute(
      { command: "echo network_default", reason: "testing" },
      baseContext,
    );
    expect(result.isError).toBe(false);
    expect(proxyGetOrStartSession).not.toHaveBeenCalled();
  });

  test("tool definition includes required schema fields", () => {
    const def = shellTool;
    const schema = def.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(def.name).toBe("bash");
    expect(schema.required).toContain("command");
    expect(schema.required).toContain("activity");
    expect(schema.properties.command).toBeDefined();
    expect(schema.properties.timeout_seconds).toBeDefined();
    expect(schema.properties.network_mode).toBeDefined();
    expect(schema.properties.credential_ids).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Shell output formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("formatShellOutput", () => {
  test("successful command with output", () => {
    const result = formatShellOutput("hello world", "", 0, false, 120);
    expect(result.content).toBe("hello world");
    expect(result.isError).toBe(false);
    expect(result.status).toBeUndefined();
  });

  test("successful command with no output shows completion tag", () => {
    const result = formatShellOutput("", "", 0, false, 120);
    expect(result.content).toBe("<command_completed />");
    expect(result.isError).toBe(false);
  });

  test("failed command with no output shows exit code tag and descriptive message", () => {
    const result = formatShellOutput("", "", 1, false, 120);
    expect(result.content).toContain('<command_exit code="1" />');
    expect(result.content).toContain("Command failed with exit code 1");
    expect(result.content).toContain("No stdout or stderr output was produced");
    expect(result.isError).toBe(true);
    expect(result.status).toContain('<command_exit code="1" />');
  });

  test("failed command with output includes exit code in status", () => {
    const result = formatShellOutput(
      "some output",
      "some error",
      1,
      false,
      120,
    );
    expect(result.content).toContain("some output");
    expect(result.content).toContain("some error");
    expect(result.isError).toBe(true);
    expect(result.status).toContain('<command_exit code="1" />');
  });

  test("timed out command includes timeout tag", () => {
    const result = formatShellOutput("partial output", "", null, true, 30);
    expect(result.content).toContain('<command_timeout seconds="30" />');
    expect(result.isError).toBe(true);
    expect(result.status).toContain('<command_timeout seconds="30" />');
  });

  test("combines stderr with stdout", () => {
    const result = formatShellOutput("stdout", "stderr", 0, false, 120);
    expect(result.content).toContain("stdout");
    expect(result.content).toContain("stderr");
  });

  test("truncates very long output", () => {
    const longOutput = "x".repeat(30_000);
    const result = formatShellOutput(longOutput, "", 0, false, 120);
    expect(result.content).toContain('limit="20K"');
    // Extract the file="..." attribute from the truncation tag
    const fileMatch = result.content.match(/file="([^"]+)"/);
    expect(fileMatch).not.toBeNull();
    const filePath = fileMatch![1];
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(longOutput);
  });
});

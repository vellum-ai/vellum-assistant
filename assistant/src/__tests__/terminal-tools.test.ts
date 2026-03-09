import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ShellOutputResult } from "../tools/shared/shell-output.js";
import type { SandboxBackend } from "../tools/terminal/backends/types.js";
import type { Tool } from "../tools/types.js";

// ── Mock modules ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target: Record<string, unknown>, _prop: string) => () => {},
    }),
}));

const testTmpDir = mkdtempSync(join(tmpdir(), "terminal-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testTmpDir,
  getDataDir: () => join(testTmpDir, "data"),
  getSandboxWorkingDir: () => join(testTmpDir, "sandbox"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testTmpDir, "test.sock"),
  getPidPath: () => join(testTmpDir, "test.pid"),
  getDbPath: () => join(testTmpDir, "test.db"),
  getLogPath: () => join(testTmpDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600 },
    sandbox: {
      enabled: false,
      backend: "native",
      docker: {
        image: "vellum-sandbox:latest",
        shell: "bash",
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 256,
        network: "none",
      },
    },
  }),
  loadConfig: () => ({}),
}));

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

import type { SandboxConfig } from "../config/schema.js";
import { parse } from "../tools/terminal/parser.js";
import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { wrapCommand } from "../tools/terminal/sandbox.js";
import { ToolError } from "../util/errors.js";

// ═══════════════════════════════════════════════════════════════════════════
//  1. Shell Parser — parse()
// ═══════════════════════════════════════════════════════════════════════════

describe("Shell parser", () => {
  // ── Basic segment extraction ──────────────────────────────────────────

  describe("segment extraction", () => {
    test("simple command", async () => {
      const result = await parse("ls -la");
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].program).toBe("ls");
      expect(result.segments[0].args).toContain("-la");
      expect(result.segments[0].operator).toBe("");
    });

    test("command with multiple arguments", async () => {
      const result = await parse('git commit -m "initial commit"');
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].program).toBe("git");
      expect(result.segments[0].args).toContain("commit");
      expect(result.segments[0].args).toContain("-m");
    });

    test("compound command with &&", async () => {
      const result = await parse("mkdir foo && cd foo");
      expect(result.segments.length).toBe(2);
      expect(result.segments[0].program).toBe("mkdir");
      expect(result.segments[0].operator).toBe("");
      expect(result.segments[1].program).toBe("cd");
      expect(result.segments[1].operator).toBe("&&");
    });

    test("compound command with ||", async () => {
      const result = await parse("test -f foo || echo missing");
      expect(result.segments.length).toBe(2);
      expect(result.segments[1].operator).toBe("||");
      expect(result.segments[1].program).toBe("echo");
    });

    test("compound command with semicolons", async () => {
      const result = await parse("echo a; echo b; echo c");
      expect(result.segments.length).toBe(3);
      // tree-sitter parses semicolons as list separators; the parser resets
      // operator to '' after each child, so the second/third segments may
      // carry ';' or '' depending on the tree-sitter-bash grammar version.
      // The key invariant is that we get 3 segments.
      const programs = result.segments.map((s) => s.program);
      expect(programs).toEqual(["echo", "echo", "echo"]);
    });

    test("pipeline", async () => {
      const result = await parse("cat file.txt | grep pattern | wc -l");
      expect(result.segments.length).toBe(3);
      expect(result.segments[0].program).toBe("cat");
      expect(result.segments[0].operator).toBe("");
      expect(result.segments[1].program).toBe("grep");
      expect(result.segments[1].operator).toBe("|");
      expect(result.segments[2].program).toBe("wc");
      expect(result.segments[2].operator).toBe("|");
    });

    test("pipeline combined with &&", async () => {
      const result = await parse("ls | wc -l && echo done");
      expect(result.segments.length).toBe(3);
      expect(result.segments[0].operator).toBe("");
      expect(result.segments[1].operator).toBe("|");
      expect(result.segments[2].operator).toBe("&&");
    });

    test("redirected statement extracts command from inside", async () => {
      const result = await parse("echo hello > output.txt");
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].program).toBe("echo");
    });

    test("subshell extracts inner commands", async () => {
      const result = await parse("(echo hello && echo world)");
      expect(result.segments.length).toBe(2);
      expect(result.segments[0].program).toBe("echo");
      expect(result.segments[1].program).toBe("echo");
    });

    test("empty command produces no segments", async () => {
      const result = await parse("");
      expect(result.segments.length).toBe(0);
    });

    test("for loop extracts body commands", async () => {
      const result = await parse("for i in a b c; do echo $i; done");
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
      const programs = result.segments.map((s) => s.program);
      expect(programs).toContain("echo");
    });

    test("if statement extracts body commands", async () => {
      const result = await parse("if true; then echo yes; fi");
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
      const programs = result.segments.map((s) => s.program);
      expect(programs).toContain("echo");
    });

    test("command with string arguments", async () => {
      const result = await parse("echo 'single quoted' \"double quoted\"");
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].program).toBe("echo");
    });
  });

  // ── Dangerous pattern detection ───────────────────────────────────────

  describe("dangerous patterns", () => {
    test("pipe to bash detected", async () => {
      const result = await parse("curl http://example.com | bash");
      expect(result.dangerousPatterns.length).toBeGreaterThanOrEqual(1);
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("pipe_to_shell");
    });

    test("pipe to sh detected", async () => {
      const result = await parse("cat script.sh | sh");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("pipe_to_shell");
    });

    test("pipe to zsh detected", async () => {
      const result = await parse('echo "code" | zsh');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("pipe_to_shell");
    });

    test("pipe to eval detected", async () => {
      const result = await parse('echo "echo hi" | eval');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("pipe_to_shell");
    });

    test("pipe to xargs detected", async () => {
      const result = await parse('find . -name "*.tmp" | xargs rm');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("pipe_to_shell");
    });

    test("pipe to grep is not flagged as pipe_to_shell", async () => {
      const result = await parse("cat file | grep pattern");
      const pipeToShell = result.dangerousPatterns.filter(
        (p) => p.type === "pipe_to_shell",
      );
      expect(pipeToShell.length).toBe(0);
    });

    test("base64 decode piped to bash detected", async () => {
      const result = await parse("echo payload | base64 -d | bash");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("base64_execute");
    });

    test("redirect to sensitive path ~/.ssh/ detected", async () => {
      const result = await parse("echo key > ~/.ssh/authorized_keys");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("sensitive_redirect");
    });

    test("redirect to sensitive path ~/.bashrc detected", async () => {
      const result = await parse('echo "export FOO=bar" >> ~/.bashrc');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("sensitive_redirect");
    });

    test("redirect to /etc/ detected", async () => {
      const result = await parse(
        'echo "nameserver 8.8.8.8" > /etc/resolv.conf',
      );
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("sensitive_redirect");
    });

    test("redirect to normal path is not flagged", async () => {
      const result = await parse("echo hello > /tmp/output.txt");
      const sensitive = result.dangerousPatterns.filter(
        (p) => p.type === "sensitive_redirect",
      );
      expect(sensitive.length).toBe(0);
    });

    test("command substitution as argument to rm detected", async () => {
      const result = await parse('rm $(find . -name "*.tmp")');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("dangerous_substitution");
    });

    test("command substitution as argument to chmod detected", async () => {
      const result = await parse("chmod $(cat perms) file");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("dangerous_substitution");
    });

    test("assignment to PATH detected as env_injection", async () => {
      const result = await parse("PATH=/evil:$PATH ls");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("env_injection");
    });

    test("assignment to LD_PRELOAD detected as env_injection", async () => {
      const result = await parse("LD_PRELOAD=/evil/lib.so cmd");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("env_injection");
    });

    test("assignment to NODE_OPTIONS detected as env_injection", async () => {
      const result = await parse('NODE_OPTIONS="--require=evil" node');
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("env_injection");
    });

    test("assignment to harmless variable is not flagged", async () => {
      const result = await parse("FOO=bar echo hello");
      const envInjection = result.dangerousPatterns.filter(
        (p) => p.type === "env_injection",
      );
      expect(envInjection.length).toBe(0);
    });

    test("process substitution detected", async () => {
      const result = await parse("diff <(sort a.txt) <(sort b.txt)");
      const types = result.dangerousPatterns.map((p) => p.type);
      expect(types).toContain("process_substitution");
    });
  });

  // ── Opaque construct detection ────────────────────────────────────────

  describe("opaque constructs", () => {
    test("eval is opaque", async () => {
      const result = await parse('eval "echo hello"');
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("source is opaque", async () => {
      const result = await parse("source ~/.bashrc");
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("dot-source is opaque", async () => {
      const result = await parse(". ~/.profile");
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("bash -c is opaque", async () => {
      const result = await parse('bash -c "echo hello"');
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("sh -c is opaque", async () => {
      const result = await parse('sh -c "rm -rf /"');
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("zsh -c is opaque", async () => {
      const result = await parse('zsh -c "echo hi"');
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("bash -ec is opaque", async () => {
      const result = await parse('bash -ec "echo careful"');
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("heredoc is opaque", async () => {
      const result = await parse("cat <<EOF\nhello world\nEOF");
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("variable expansion as command is opaque", async () => {
      const result = await parse("$CMD arg1 arg2");
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("command substitution as command is opaque", async () => {
      const result = await parse("$(get_cmd) arg1 arg2");
      expect(result.hasOpaqueConstructs).toBe(true);
    });

    test("simple command is not opaque", async () => {
      const result = await parse("ls -la /tmp");
      expect(result.hasOpaqueConstructs).toBe(false);
    });

    test("pipeline of safe commands is not opaque", async () => {
      const result = await parse("cat file | grep pattern | wc -l");
      expect(result.hasOpaqueConstructs).toBe(false);
    });

    test("compound safe commands are not opaque", async () => {
      const result = await parse("mkdir foo && cd foo && touch bar");
      expect(result.hasOpaqueConstructs).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Safe Environment — buildSanitizedEnv()
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

  test("injects INTERNAL_GATEWAY_BASE_URL from gateway config", () => {
    process.env.GATEWAY_INTERNAL_BASE_URL = "http://gateway.internal:9000/";
    const env = buildSanitizedEnv();
    expect(env.INTERNAL_GATEWAY_BASE_URL).toBe("http://gateway.internal:9000");
    delete process.env.GATEWAY_INTERNAL_BASE_URL;
  });

  test("result is a plain object with no prototype-inherited secrets", () => {
    const env = buildSanitizedEnv();
    const keys = Object.keys(env);
    const safeKeys = [
      "PATH",
      "HOME",
      "TERM",
      "LANG",
      "EDITOR",
      "SHELL",
      "USER",
      "TMPDIR",
      "LC_ALL",
      "LC_CTYPE",
      "XDG_RUNTIME_DIR",
      "DISPLAY",
      "COLORTERM",
      "TERM_PROGRAM",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "GPG_TTY",
      "GNUPGHOME",
      "INTERNAL_GATEWAY_BASE_URL",
      "VELLUM_DATA_DIR",
    ];
    for (const key of keys) {
      expect(safeKeys).toContain(key);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. Sandbox wrapCommand
// ═══════════════════════════════════════════════════════════════════════════

describe("wrapCommand", () => {
  const disabledConfig: SandboxConfig = {
    enabled: false,
  };

  test("disabled sandbox returns plain bash invocation", () => {
    const result = wrapCommand("echo hello", "/tmp", disabledConfig);
    expect(result.command).toBe("bash");
    expect(result.args).toEqual(["-c", "--", "echo hello"]);
    expect(result.sandboxed).toBe(false);
  });

  test("disabled sandbox preserves command verbatim", () => {
    const cmd = 'ls -la /foo && echo "done"';
    const result = wrapCommand(cmd, "/tmp", disabledConfig);
    expect(result.args[2]).toBe(cmd);
  });

  test("disabled sandbox works with special characters in command", () => {
    const cmd = "echo 'hello world' | grep 'hello'";
    const result = wrapCommand(cmd, "/tmp", disabledConfig);
    expect(result.args[2]).toBe(cmd);
    expect(result.sandboxed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Native sandbox backend — path safety
// ═══════════════════════════════════════════════════════════════════════════

describe("Native sandbox backend", () => {
  // We test NativeBackend directly rather than through wrapCommand to avoid
  // platform-dependent sandbox-exec/bwrap availability.
  let NativeBackend: new () => SandboxBackend;

  beforeEach(async () => {
    const mod = await import("../tools/terminal/backends/native.js");
    NativeBackend = mod.NativeBackend;
  });

  if (process.platform === "darwin") {
    test("wraps command with sandbox-exec on macOS", () => {
      const backend = new NativeBackend();
      const result = backend.wrap("echo hello", "/tmp");
      expect(result.command).toBe("sandbox-exec");
      expect(result.args[0]).toBe("-f");
      // Profile path is the second arg
      expect(result.args[1]).toMatch(/sandbox-profile-.*\.sb$/);
      expect(result.args).toContain("bash");
      expect(result.args).toContain("-c");
      expect(result.args).toContain("--");
      expect(result.args[result.args.length - 1]).toBe("echo hello");
      expect(result.sandboxed).toBe(true);
    });

    test("rejects working dir with SBPL metacharacters", () => {
      const backend = new NativeBackend();
      expect(() => backend.wrap("echo hi", '/tmp/foo"bar')).toThrow(ToolError);
      expect(() => backend.wrap("echo hi", "/tmp/foo(bar")).toThrow(ToolError);
      expect(() => backend.wrap("echo hi", "/tmp/foo;bar")).toThrow(ToolError);
      expect(() => backend.wrap("echo hi", "/tmp/foo\\bar")).toThrow(ToolError);
    });

    test("accepts working dir with safe special characters", () => {
      // Spaces, dots, hyphens, underscores are fine
      const backend = new NativeBackend();
      const result = backend.wrap("ls", "/tmp/my-dir_name.2024");
      expect(result.sandboxed).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Shell tool — input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Shell tool input validation", () => {
  let shellTool: Tool;

  beforeEach(async () => {
    const mod = await import("../tools/terminal/shell.js");
    shellTool = mod.shellTool;
  });

  const baseContext = {
    workingDir: testTmpDir,
    sessionId: "test-session-1",
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
    const def = shellTool.getDefinition();
    const schema = def.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(def.name).toBe("bash");
    expect(schema.required).toContain("command");
    expect(schema.required).toContain("reason");
    expect(schema.properties.command).toBeDefined();
    expect(schema.properties.timeout_seconds).toBeDefined();
    expect(schema.properties.network_mode).toBeDefined();
    expect(schema.properties.credential_ids).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  7. Shell output formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("formatShellOutput", () => {
  let formatShellOutput: (
    stdout: string,
    stderr: string,
    code: number | null,
    timedOut: boolean,
    timeoutSec: number,
  ) => ShellOutputResult;

  beforeEach(async () => {
    const mod = await import("../tools/shared/shell-output.js");
    formatShellOutput = mod.formatShellOutput;
  });

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
    const longOutput = "x".repeat(60_000);
    const result = formatShellOutput(longOutput, "", 0, false, 120);
    expect(result.content).toContain('<output_truncated limit="50K" />');
    expect(result.content.length).toBeLessThan(60_000);
  });
});

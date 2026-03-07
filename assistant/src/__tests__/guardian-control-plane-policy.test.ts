import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type {
  ToolExecutionResult,
  ToolLifecycleEvent,
  ToolPermissionDeniedEvent,
} from "../tools/types.js";

// ── Module mocks (must precede real imports) ─────────────────────────

const mockConfig = {
  provider: "anthropic",
  model: "test",
  apiKeys: {},
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: {
    enabled: false,
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => "low",
  check: async () => ({ decision: "allow", reason: "allowed" }),
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
}));

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") return undefined;
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      getDefinition: () => ({}),
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));

// ── Real imports ─────────────────────────────────────────────────────

import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import {
  enforceGuardianOnlyPolicy,
  isGuardianControlPlaneInvocation,
} from "../tools/guardian-control-plane-policy.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    sessionId: "session-1",
    conversationId: "conversation-1",
    trustClass: "guardian",
    ...overrides,
  };
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

import { resetDb } from "../memory/db.js";
import { initializeDb } from "../memory/db-init.js";

beforeAll(() => {
  initializeDb();
});
afterAll(() => {
  resetDb();
  mock.restore();
});

// =====================================================================
// Unit tests: isGuardianControlPlaneInvocation
// =====================================================================

describe("isGuardianControlPlaneInvocation", () => {
  const guardianPaths = [
    "/v1/channel-verification-sessions",
    "/v1/channel-verification-sessions/status",
    "/v1/channel-verification-sessions/resend",
    "/v1/channel-verification-sessions/revoke",
  ];

  describe("bash tool with guardian endpoint in command", () => {
    for (const path of guardianPaths) {
      test(`detects curl to ${path}`, () => {
        expect(
          isGuardianControlPlaneInvocation("bash", {
            command: `curl -X POST http://localhost:3000${path}`,
          }),
        ).toBe(true);
      });

      test(`detects wget to ${path}`, () => {
        expect(
          isGuardianControlPlaneInvocation("bash", {
            command: `wget https://api.example.com${path}`,
          }),
        ).toBe(true);
      });
    }

    test("does not match unrelated commands", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command: "git status",
        }),
      ).toBe(false);
    });

    test("matches partial path prefix via fragment detection (fail-closed for shell tools)", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("matches unknown sub-path under guardian control-plane (broad pattern)", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel-verification-sessions/other",
        }),
      ).toBe(true);
    });

    test("handles missing command field gracefully", () => {
      expect(isGuardianControlPlaneInvocation("bash", {})).toBe(false);
    });

    test("handles non-string command field gracefully", () => {
      expect(isGuardianControlPlaneInvocation("bash", { command: 42 })).toBe(
        false,
      );
    });
  });

  describe("host_bash tool with guardian endpoint in command", () => {
    test("detects guardian endpoint", () => {
      expect(
        isGuardianControlPlaneInvocation("host_bash", {
          command:
            'curl -H "Authorization: Bearer token" https://internal:8080/v1/channel-verification-sessions',
        }),
      ).toBe(true);
    });
  });

  describe("network_request tool with guardian endpoint in url", () => {
    for (const path of guardianPaths) {
      test(`detects ${path}`, () => {
        expect(
          isGuardianControlPlaneInvocation("network_request", {
            url: `https://api.vellum.ai${path}`,
          }),
        ).toBe(true);
      });
    }

    test("detects proxied local URL", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "http://127.0.0.1:3000/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("does not match unrelated URLs", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/messages",
        }),
      ).toBe(false);
    });

    test("handles missing url field gracefully", () => {
      expect(isGuardianControlPlaneInvocation("network_request", {})).toBe(
        false,
      );
    });
  });

  describe("web_fetch tool with guardian endpoint in url", () => {
    test("detects guardian endpoint", () => {
      expect(
        isGuardianControlPlaneInvocation("web_fetch", {
          url: "https://api.example.com/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("does not match unrelated URL", () => {
      expect(
        isGuardianControlPlaneInvocation("web_fetch", {
          url: "https://docs.example.com/api/v1/help",
        }),
      ).toBe(false);
    });
  });

  describe("browser_navigate tool with guardian endpoint in url", () => {
    test("detects guardian endpoint", () => {
      expect(
        isGuardianControlPlaneInvocation("browser_navigate", {
          url: "http://localhost:3000/v1/channel-verification-sessions/status",
        }),
      ).toBe(true);
    });
  });

  describe("unrelated tools are not flagged", () => {
    test("file_read is never a guardian invocation", () => {
      expect(
        isGuardianControlPlaneInvocation("file_read", {
          path: "/v1/channel-verification-sessions",
        }),
      ).toBe(false);
    });

    test("file_write is never a guardian invocation", () => {
      expect(
        isGuardianControlPlaneInvocation("file_write", {
          path: "/tmp/test.txt",
          content: "curl /v1/channel-verification-sessions",
        }),
      ).toBe(false);
    });

    test("web_search is never a guardian invocation", () => {
      expect(
        isGuardianControlPlaneInvocation("web_search", {
          query: "/v1/channel-verification-sessions/status",
        }),
      ).toBe(false);
    });
  });

  describe("path matching covers proxied and local variants", () => {
    test("matches endpoint with query string", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/channel-verification-sessions?token=abc",
        }),
      ).toBe(true);
    });

    test("matches endpoint with trailing slash", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/channel-verification-sessions/resend/",
        }),
      ).toBe(true);
    });

    test("matches endpoint in piped bash command", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            'echo \'{"phone":"+1234567890"}\' | curl -X POST -d @- http://localhost:3000/v1/channel-verification-sessions/resend',
        }),
      ).toBe(true);
    });
  });

  describe("obfuscation resistance", () => {
    test("detects URL-encoded path (%2F encoding)", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel%2Dverification%2Dsessions",
        }),
      ).toBe(true);
    });

    test("detects double slashes in path", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1//channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("detects triple slashes in path", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/v1///channel-verification-sessions///status",
        }),
      ).toBe(true);
    });

    test("detects mixed case path", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/V1/Channel-Verification-Sessions/Status",
        }),
      ).toBe(true);
    });

    test("detects ALL CAPS path", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/V1/CHANNEL-VERIFICATION-SESSIONS",
        }),
      ).toBe(true);
    });

    test("detects combined obfuscation: double slashes + mixed case", () => {
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/v1//Channel-Verification-Sessions/status",
        }),
      ).toBe(true);
    });

    test("does not false-positive on unrelated encoded paths", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/integrations%2Fother%2Fservice",
        }),
      ).toBe(false);
    });

    test("detects endpoint despite malformed percent-encoding elsewhere in command", () => {
      const result = isGuardianControlPlaneInvocation("bash", {
        command:
          'curl -H "X: %ZZ" http://localhost:3000/v1/channel-verification-sessions -d \'{"channel":"sms"}\'',
      });
      expect(result).toBe(true);
    });
  });

  describe("shell expansion resistance", () => {
    test("detects endpoint constructed via shell variable concatenation", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            'base=http://localhost:7821/v1; seg=channel-verification-sessions; curl "$base/$seg/status"',
        }),
      ).toBe(true);
    });

    test("detects endpoint with split variable assignment", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            'API=channel-verification-sessions; curl "http://localhost:3000/v1/${API}"',
        }),
      ).toBe(true);
    });

    test("detects endpoint with path built across multiple variables", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            'HOST=http://localhost:7821; ENDPOINT=channel-verification-sessions; curl "$HOST/v1/$ENDPOINT"',
        }),
      ).toBe(true);
    });

    test("detects endpoint via heredoc-style construction", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command:
            'url="http://localhost:3000/v1/channel-verification-sessions"; curl "${url}/resend"',
        }),
      ).toBe(true);
    });

    test("does not false-positive on unrelated paths", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command: "curl http://localhost:3000/v1/integrations/other/service",
        }),
      ).toBe(false);
    });

    test("does not false-positive when only guardian is present without verification path", () => {
      expect(
        isGuardianControlPlaneInvocation("bash", {
          command: 'echo "guardian notification sent"',
        }),
      ).toBe(false);
    });

    test("shell fragment detection does not apply to URL tools", () => {
      // URL tools pass structured URLs, not shell commands. The fragment detector
      // is bash/host_bash only. For URL tools, we rely on exact/normalized matching.
      expect(
        isGuardianControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/messages",
        }),
      ).toBe(false);
    });
  });
});

// =====================================================================
// Unit tests: enforceGuardianOnlyPolicy
// =====================================================================

describe("enforceGuardianOnlyPolicy", () => {
  test("non-guardian actor denied for guardian endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "trusted_contact",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("unverified_channel actor denied for guardian endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "network_request",
      {
        url: "https://api.example.com/v1/channel-verification-sessions",
      },
      "unknown",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("guardian actor is NOT denied for guardian endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "guardian",
    );
    expect(result.denied).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("guardian actor role is NOT denied for guardian endpoint (explicit)", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "guardian",
    );
    expect(result.denied).toBe(false);
  });

  test("unknown actor role is denied for guardian endpoint (allowlist, not denylist)", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "some_future_role",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("non-guardian actor is NOT denied for unrelated endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/messages",
      },
      "trusted_contact",
    );
    expect(result.denied).toBe(false);
  });

  test("non-guardian actor is NOT denied for unrelated tool", () => {
    const result = enforceGuardianOnlyPolicy(
      "file_read",
      {
        path: "README.md",
      },
      "trusted_contact",
    );
    expect(result.denied).toBe(false);
  });
});

// =====================================================================
// Integration tests: ToolExecutor guardian-only policy gate
// =====================================================================

describe("ToolExecutor guardian-only policy gate", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
  });

  test("non-guardian actor blocked from bash curl to guardian sessions", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      {
        command:
          "curl -X POST http://localhost:3000/v1/channel-verification-sessions",
      },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("unverified_channel actor blocked from network_request to guardian endpoint", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "network_request",
      { url: "https://api.example.com/v1/channel-verification-sessions" },
      makeContext({ trustClass: "unknown" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("guardian actor is NOT blocked from the same invocation", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      {
        command:
          "curl -X POST http://localhost:3000/v1/channel-verification-sessions",
      },
      makeContext({ trustClass: "guardian" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("guardian trust class is NOT blocked from guardian endpoint (default)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      {
        command:
          "curl http://localhost:3000/v1/channel-verification-sessions/status",
      },
      makeContext(), // defaults to trustClass: 'guardian'
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("non-guardian invocation of unrelated bash command is blocked by guardian approval gate", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "curl http://localhost:3000/v1/messages" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires guardian approval");
  });

  test("non-guardian invocation of unrelated tool is unaffected", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("permission_denied lifecycle event is emitted on guardian policy block", async () => {
    let capturedEvent: ToolPermissionDeniedEvent | undefined;
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "bash",
      {
        command:
          "curl -X DELETE http://localhost:3000/v1/channel-verification-sessions",
      },
      makeContext({
        trustClass: "trusted_contact",
        onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
          if (event.type === "permission_denied") {
            capturedEvent = event as ToolPermissionDeniedEvent;
          }
        },
      }),
    );
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.decision).toBe("deny");
    expect(capturedEvent!.reason).toContain("restricted to guardian users");
  });

  test("non-guardian blocked from web_fetch to guardian endpoint", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "web_fetch",
      { url: "http://localhost:3000/v1/channel-verification-sessions/resend" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("non-guardian blocked from browser_navigate to guardian endpoint", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "browser_navigate",
      { url: "http://localhost:3000/v1/channel-verification-sessions/status" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("non-guardian blocked from host_bash with guardian endpoint", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_bash",
      {
        command:
          "curl -X POST https://internal:8080/v1/channel-verification-sessions",
      },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("all guardian endpoints are blocked for non-guardian via network_request", async () => {
    const endpoints = [
      "/v1/channel-verification-sessions",
      "/v1/channel-verification-sessions/status",
      "/v1/channel-verification-sessions/resend",
      "/v1/channel-verification-sessions/revoke",
    ];

    for (const path of endpoints) {
      const executor = new ToolExecutor(makePrompter());
      const result = await executor.execute(
        "network_request",
        { url: `https://api.example.com${path}` },
        makeContext({ trustClass: "trusted_contact" }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("restricted to guardian users");
    }
  });

  test("non-guardian actor is blocked from host read tools (host execution)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_file_read",
      { path: "/Users/noaflaherty/.ssh/config" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires guardian approval");
  });

  test("unverified channel actor is blocked from side-effect tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "reminder_create",
      { fire_at: "2026-02-27T12:00:00-05:00", label: "test", message: "hello" },
      makeContext({ trustClass: "unknown" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("verified channel identity");
  });

  test("guardian actor can execute side-effect tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "reminder_create",
      { fire_at: "2026-02-27T12:00:00-05:00", label: "test", message: "hello" },
      makeContext({ trustClass: "guardian" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });
});

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

// -- Module mocks (must precede real imports) --

const mockConfig = {
  provider: "anthropic",
  model: "test",
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
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: false,
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
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
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: "low" }),
  check: async () => ({ decision: "allow", reason: "allowed" }),
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
  getCachedAssessment: () => undefined,
}));

mock.module("../memory/conversation-crud.js", () => ({
  createConversation: (title: string) => ({ id: "conversation-1", title }),
}));

// Mock every export so downstream test files that dynamically import modules
// with a static `from "../memory/tool-usage-store.js"` still see all symbols.
mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
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

// Re-assert the real verification-control-plane-policy implementation.
// This overrides any mock that an earlier test file may have installed for
// this module (e.g. tool-approval-handler.test.ts mocks it with denied:false).
// The real functions are pure and have no external dependencies so they can
// be inlined here without importing from the original source.
mock.module("../tools/verification-control-plane-policy.js", () => {
  const VERIFICATION_PATH_REGEX = /\/v1\/channel-verification-sessions/;
  const COMMAND_TOOLS = new Set(["bash", "host_bash"]);
  const URL_TOOLS = new Set(["network_request", "web_fetch"]);

  function normalizeForMatching(value: string): string {
    let normalized = value;
    let prev = "";
    while (prev !== normalized) {
      prev = normalized;
      normalized = normalized.replace(/%[0-9a-fA-F]{2}/g, (match) => {
        try {
          return decodeURIComponent(match);
        } catch {
          return match;
        }
      });
    }
    normalized = normalized.replace(/(?<!:)\/{2,}/g, "/");
    return normalized.toLowerCase();
  }

  function containsVerificationEndpointPath(value: string): boolean {
    const normalized = normalizeForMatching(value);
    const VERIFICATION_ENDPOINT_PATHS = [
      "/v1/channel-verification-sessions",
      "/v1/channel-verification-sessions/resend",
      "/v1/channel-verification-sessions/status",
      "/v1/channel-verification-sessions/revoke",
    ];
    for (const path of VERIFICATION_ENDPOINT_PATHS) {
      if (normalized.includes(path)) return true;
    }
    if (VERIFICATION_PATH_REGEX.test(normalized)) return true;
    return false;
  }

  function containsVerificationFragments(command: string): boolean {
    return command.toLowerCase().includes("channel-verification-sessions");
  }

  function isVerificationControlPlaneInvocation(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (COMMAND_TOOLS.has(toolName)) {
      const command = input.command;
      if (typeof command === "string") {
        if (containsVerificationEndpointPath(command)) return true;
        if (containsVerificationFragments(command)) return true;
      }
    }
    if (URL_TOOLS.has(toolName)) {
      const url = input.url;
      if (typeof url === "string" && containsVerificationEndpointPath(url)) {
        return true;
      }
    }
    return false;
  }

  function enforceVerificationControlPlanePolicy(
    toolName: string,
    input: Record<string, unknown>,
    trustClass: string,
  ): { denied: boolean; reason?: string } {
    if (!isVerificationControlPlaneInvocation(toolName, input)) {
      return { denied: false };
    }
    if (trustClass === "guardian") {
      return { denied: false };
    }
    return {
      denied: true,
      reason:
        "Guardian verification control-plane actions are restricted to guardian users. This is a security restriction — please wait for the designated guardian to perform this action.",
    };
  }

  return {
    isVerificationControlPlaneInvocation,
    enforceVerificationControlPlanePolicy,
  };
});

// -- Real imports --

import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolContext } from "../tools/types.js";
import {
  enforceVerificationControlPlanePolicy,
  isVerificationControlPlaneInvocation,
} from "../tools/verification-control-plane-policy.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
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

import { initializeDb } from "../memory/db-init.js";

beforeAll(() => {
  initializeDb();
});
afterAll(() => {
  mock.restore();
});

// =====================================================================
// Unit tests: isVerificationControlPlaneInvocation
// =====================================================================

describe("isVerificationControlPlaneInvocation", () => {
  const verificationPaths = [
    "/v1/channel-verification-sessions",
    "/v1/channel-verification-sessions/status",
    "/v1/channel-verification-sessions/resend",
    "/v1/channel-verification-sessions/revoke",
  ];

  describe("bash tool with verification endpoint in command", () => {
    for (const path of verificationPaths) {
      test(`detects curl to ${path}`, () => {
        expect(
          isVerificationControlPlaneInvocation("bash", {
            command: `curl -X POST http://localhost:3000${path}`,
          }),
        ).toBe(true);
      });

      test(`detects wget to ${path}`, () => {
        expect(
          isVerificationControlPlaneInvocation("bash", {
            command: `wget https://api.example.com${path}`,
          }),
        ).toBe(true);
      });
    }

    test("does not match unrelated commands", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command: "git status",
        }),
      ).toBe(false);
    });

    test("matches partial path prefix via fragment detection (fail-closed for shell tools)", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("matches unknown sub-path under verification control-plane (broad pattern)", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel-verification-sessions/other",
        }),
      ).toBe(true);
    });

    test("handles missing command field gracefully", () => {
      expect(isVerificationControlPlaneInvocation("bash", {})).toBe(false);
    });

    test("handles non-string command field gracefully", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", { command: 42 }),
      ).toBe(false);
    });
  });

  describe("host_bash tool with verification endpoint in command", () => {
    test("detects verification endpoint", () => {
      expect(
        isVerificationControlPlaneInvocation("host_bash", {
          command:
            'curl -H "Authorization: Bearer token" https://internal:8080/v1/channel-verification-sessions',
        }),
      ).toBe(true);
    });
  });

  describe("network_request tool with verification endpoint in url", () => {
    for (const path of verificationPaths) {
      test(`detects ${path}`, () => {
        expect(
          isVerificationControlPlaneInvocation("network_request", {
            url: `https://api.vellum.ai${path}`,
          }),
        ).toBe(true);
      });
    }

    test("detects proxied local URL", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "http://127.0.0.1:3000/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("does not match unrelated URLs", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/messages",
        }),
      ).toBe(false);
    });

    test("handles missing url field gracefully", () => {
      expect(isVerificationControlPlaneInvocation("network_request", {})).toBe(
        false,
      );
    });
  });

  describe("web_fetch tool with verification endpoint in url", () => {
    test("detects verification endpoint", () => {
      expect(
        isVerificationControlPlaneInvocation("web_fetch", {
          url: "https://api.example.com/v1/channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("does not match unrelated URL", () => {
      expect(
        isVerificationControlPlaneInvocation("web_fetch", {
          url: "https://docs.example.com/api/v1/help",
        }),
      ).toBe(false);
    });
  });

  describe("unrelated tools are not flagged", () => {
    test("file_read is never a verification invocation", () => {
      expect(
        isVerificationControlPlaneInvocation("file_read", {
          path: "/v1/channel-verification-sessions",
        }),
      ).toBe(false);
    });

    test("file_write is never a verification invocation", () => {
      expect(
        isVerificationControlPlaneInvocation("file_write", {
          path: "/tmp/test.txt",
          content: "curl /v1/channel-verification-sessions",
        }),
      ).toBe(false);
    });

    test("web_search is never a verification invocation", () => {
      expect(
        isVerificationControlPlaneInvocation("web_search", {
          query: "/v1/channel-verification-sessions/status",
        }),
      ).toBe(false);
    });
  });

  describe("path matching covers proxied and local variants", () => {
    test("matches endpoint with query string", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/channel-verification-sessions?token=abc",
        }),
      ).toBe(true);
    });

    test("matches endpoint with trailing slash", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/channel-verification-sessions/resend/",
        }),
      ).toBe(true);
    });

    test("matches endpoint in piped bash command", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            'echo \'{"phone":"+1234567890"}\' | curl -X POST -d @- http://localhost:3000/v1/channel-verification-sessions/resend',
        }),
      ).toBe(true);
    });
  });

  describe("obfuscation resistance", () => {
    test("detects URL-encoded path (%2F encoding)", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/channel%2Dverification%2Dsessions",
        }),
      ).toBe(true);
    });

    test("detects double slashes in path", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1//channel-verification-sessions",
        }),
      ).toBe(true);
    });

    test("detects triple slashes in path", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/v1///channel-verification-sessions///status",
        }),
      ).toBe(true);
    });

    test("detects mixed case path", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/V1/Channel-Verification-Sessions/Status",
        }),
      ).toBe(true);
    });

    test("detects ALL CAPS path", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/V1/CHANNEL-VERIFICATION-SESSIONS",
        }),
      ).toBe(true);
    });

    test("detects combined obfuscation: double slashes + mixed case", () => {
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "http://localhost:3000/v1//Channel-Verification-Sessions/status",
        }),
      ).toBe(true);
    });

    test("does not false-positive on unrelated encoded paths", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            "curl http://localhost:3000/v1/integrations%2Fother%2Fservice",
        }),
      ).toBe(false);
    });

    test("detects endpoint despite malformed percent-encoding elsewhere in command", () => {
      const result = isVerificationControlPlaneInvocation("bash", {
        command:
          'curl -H "X: %ZZ" http://localhost:3000/v1/channel-verification-sessions -d \'{"channel":"telegram"}\'',
      });
      expect(result).toBe(true);
    });
  });

  describe("shell expansion resistance", () => {
    test("detects endpoint constructed via shell variable concatenation", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            'base=http://localhost:7821/v1; seg=channel-verification-sessions; curl "$base/$seg/status"',
        }),
      ).toBe(true);
    });

    test("detects endpoint with split variable assignment", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            'API=channel-verification-sessions; curl "http://localhost:3000/v1/${API}"',
        }),
      ).toBe(true);
    });

    test("detects endpoint with path built across multiple variables", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            'HOST=http://localhost:7821; ENDPOINT=channel-verification-sessions; curl "$HOST/v1/$ENDPOINT"',
        }),
      ).toBe(true);
    });

    test("detects endpoint via heredoc-style construction", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command:
            'url="http://localhost:3000/v1/channel-verification-sessions"; curl "${url}/resend"',
        }),
      ).toBe(true);
    });

    test("does not false-positive on unrelated paths", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command: "curl http://localhost:3000/v1/integrations/other/service",
        }),
      ).toBe(false);
    });

    test("does not false-positive when only guardian is present without verification path", () => {
      expect(
        isVerificationControlPlaneInvocation("bash", {
          command: 'echo "guardian notification sent"',
        }),
      ).toBe(false);
    });

    test("shell fragment detection does not apply to URL tools", () => {
      // URL tools pass structured URLs, not shell commands. The fragment detector
      // is bash/host_bash only. For URL tools, we rely on exact/normalized matching.
      expect(
        isVerificationControlPlaneInvocation("network_request", {
          url: "https://api.example.com/v1/messages",
        }),
      ).toBe(false);
    });
  });
});

// =====================================================================
// Unit tests: enforceVerificationControlPlanePolicy
// =====================================================================

describe("enforceVerificationControlPlanePolicy", () => {
  test("non-guardian actor denied for verification endpoint", () => {
    const result = enforceVerificationControlPlanePolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "trusted_contact",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("unverified_channel actor denied for verification endpoint", () => {
    const result = enforceVerificationControlPlanePolicy(
      "network_request",
      {
        url: "https://api.example.com/v1/channel-verification-sessions",
      },
      "unknown",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("guardian actor is NOT denied for verification endpoint", () => {
    const result = enforceVerificationControlPlanePolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "guardian",
    );
    expect(result.denied).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("guardian actor role is NOT denied for verification endpoint (explicit)", () => {
    const result = enforceVerificationControlPlanePolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/channel-verification-sessions",
      },
      "guardian",
    );
    expect(result.denied).toBe(false);
  });

  test("unknown actor role is denied for verification endpoint (allowlist, not denylist)", () => {
    const result = enforceVerificationControlPlanePolicy(
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
    const result = enforceVerificationControlPlanePolicy(
      "bash",
      {
        command: "curl http://localhost:3000/v1/messages",
      },
      "trusted_contact",
    );
    expect(result.denied).toBe(false);
  });

  test("non-guardian actor is NOT denied for unrelated tool", () => {
    const result = enforceVerificationControlPlanePolicy(
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
// Integration tests: ToolExecutor verification control-plane policy gate
// =====================================================================

describe("ToolExecutor verification control-plane policy gate", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
  });

  test("non-guardian actor blocked from bash curl to verification sessions", async () => {
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

  test("unverified_channel actor blocked from network_request to verification endpoint", async () => {
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

  test("guardian trust class is NOT blocked from verification endpoint (default)", async () => {
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

  test("non-guardian invocation of unrelated bash command requires guardian grant", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "curl http://localhost:3000/v1/messages" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
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

  test("permission_denied lifecycle event is emitted on verification policy block", async () => {
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

  test("non-guardian blocked from web_fetch to verification endpoint", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "web_fetch",
      { url: "http://localhost:3000/v1/channel-verification-sessions/resend" },
      makeContext({ trustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("restricted to guardian users");
  });

  test("non-guardian blocked from host_bash with verification endpoint", async () => {
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

  test("all verification endpoints are blocked for non-guardian via network_request", async () => {
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

  test("unverified channel actor is blocked from side-effect tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "schedule_create",
      { name: "test", fire_at: "2026-02-27T12:00:00-05:00", message: "hello" },
      makeContext({ trustClass: "unknown" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("verified channel identity");
  });

  test("guardian actor can execute side-effect tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "schedule_create",
      { name: "test", fire_at: "2026-02-27T12:00:00-05:00", message: "hello" },
      makeContext({ trustClass: "guardian" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });
});

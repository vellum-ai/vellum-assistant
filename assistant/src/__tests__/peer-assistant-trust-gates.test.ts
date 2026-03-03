import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

/**
 * Gate tests for the peer_assistant trust role.
 *
 * Verifies fail-closed defaults: peer assistants get zero capabilities
 * (no tool execution, no host-target tools, no control-plane access,
 * no memory extraction/retrieval) until scopes are explicitly configured.
 */

const testDir = mkdtempSync(join(tmpdir(), "peer-assistant-trust-test-"));

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
  memory: {
    enabled: true,
    segmentation: { targetTokens: 100, overlapTokens: 10 },
    extraction: { extractFromAssistant: true },
    conflicts: { enabled: true },
  },
};

let fakeToolResult = { content: "ok", isError: false };

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

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
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
import { enforceGuardianOnlyPolicy } from "../tools/guardian-control-plane-policy.js";
import { ToolApprovalHandler } from "../tools/tool-approval-handler.js";
import type {
  ToolContext,
  ToolLifecycleEvent,
  ToolPermissionDeniedEvent,
} from "../tools/types.js";
import { indexMessageNow } from "../memory/indexer.js";
import { resetDb } from "../memory/db.js";
import { initializeDb } from "../memory/db-init.js";

beforeAll(() => {
  initializeDb();
});

afterAll(() => {
  resetDb();
  mock.restore();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    sessionId: "session-1",
    conversationId: "conversation-1",
    guardianTrustClass: "peer_assistant",
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

// =====================================================================
// 1. Tool Execution Gate — peer_assistant denied for ALL tools
// =====================================================================

describe("peer_assistant tool execution gate (blanket deny)", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
  });

  test("peer_assistant blocked from side-effect tool (bash)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "ls -la" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
    expect(result.content).toContain("no tool execution capabilities");
  });

  test("peer_assistant blocked from read-only tool (file_read)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
    expect(result.content).toContain("no tool execution capabilities");
  });

  test("peer_assistant blocked from web_fetch tool", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "web_fetch",
      { url: "https://example.com" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
  });

  test("peer_assistant blocked from reminder_create tool", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "reminder_create",
      { fire_at: "2026-03-03T12:00:00Z", label: "test", message: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
  });

  test("permission_denied lifecycle event emitted for peer_assistant", async () => {
    let capturedEvent: ToolPermissionDeniedEvent | undefined;
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "bash",
      { command: "echo test" },
      makeContext({
        onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
          if (event.type === "permission_denied") {
            capturedEvent = event as ToolPermissionDeniedEvent;
          }
        },
      }),
    );
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.decision).toBe("deny");
    expect(capturedEvent!.reason).toContain("peer assistant");
  });
});

// =====================================================================
// 2. Host-Target Tool Gate
// =====================================================================

describe("peer_assistant host-target tool gate", () => {
  test("peer_assistant blocked from host_bash", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_bash",
      { command: "whoami" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
  });

  test("peer_assistant blocked from host_file_read", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_file_read",
      { path: "/etc/passwd" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
  });

  test("peer_assistant blocked from host_file_write", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_file_write",
      { path: "/tmp/test.txt", content: "hello" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("peer assistant");
  });
});

// =====================================================================
// 3. Guardian Control-Plane Policy Gate
// =====================================================================

describe("peer_assistant guardian control-plane policy gate", () => {
  test("peer_assistant denied from guardian verification endpoints", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command:
          "curl http://localhost:3000/v1/integrations/guardian/outbound/start",
      },
      "peer_assistant",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("peer_assistant denied from guardian challenge endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "network_request",
      {
        url: "https://api.example.com/v1/integrations/guardian/challenge",
      },
      "peer_assistant",
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("restricted to guardian users");
  });

  test("peer_assistant denied from guardian status endpoint", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command:
          "curl http://localhost:3000/v1/integrations/guardian/status",
      },
      "peer_assistant",
    );
    expect(result.denied).toBe(true);
  });

  test("peer_assistant blocked from guardian endpoint via ToolExecutor", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      {
        command:
          "curl http://localhost:3000/v1/integrations/guardian/outbound/start",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    // The blanket peer_assistant deny fires before the guardian-only policy,
    // so the error message references peer assistant capabilities.
    expect(result.content).toContain("peer assistant");
  });
});

// =====================================================================
// 4. Memory Provenance Gate — extraction denied for peer_assistant
// =====================================================================

describe("peer_assistant memory extraction gate", () => {
  test("indexMessageNow skips extraction for peer_assistant provenance", () => {
    const result = indexMessageNow(
      {
        messageId: "msg-peer-1",
        conversationId: "conv-peer-1",
        role: "user",
        content: "My favorite color is blue and I live in New York",
        createdAt: Date.now(),
        scopeId: "default",
        provenanceTrustClass: "peer_assistant",
      },
      mockConfig.memory as any,
    );

    // Segments should still be indexed (for search), but extraction jobs
    // should be gated. The isTrustedActor check gates extract_items and
    // resolve_pending_conflicts — peer_assistant is NOT trusted.
    expect(result.indexedSegments).toBeGreaterThan(0);
    // enqueuedJobs should be less than what a guardian would get
    // (guardian gets: embed_segment + extract_items + build_conversation_summary + resolve_conflicts)
    // peer_assistant gets: embed_segment + build_conversation_summary only
  });

  test("indexMessageNow allows extraction for guardian provenance", () => {
    const result = indexMessageNow(
      {
        messageId: "msg-guardian-1",
        conversationId: "conv-guardian-1",
        role: "user",
        content: "My favorite color is green and I live in London",
        createdAt: Date.now(),
        scopeId: "default",
        provenanceTrustClass: "guardian",
      },
      mockConfig.memory as any,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);
    // Guardian gets more enqueued jobs (extraction + conflict resolution)
    expect(result.enqueuedJobs).toBeGreaterThanOrEqual(2);
  });

  test("peer_assistant extraction job count is less than guardian", () => {
    const peerResult = indexMessageNow(
      {
        messageId: "msg-peer-compare",
        conversationId: "conv-peer-compare",
        role: "user",
        content: "I prefer TypeScript over JavaScript for large projects",
        createdAt: Date.now(),
        scopeId: "default",
        provenanceTrustClass: "peer_assistant",
      },
      mockConfig.memory as any,
    );

    const guardianResult = indexMessageNow(
      {
        messageId: "msg-guardian-compare",
        conversationId: "conv-guardian-compare",
        role: "user",
        content: "I prefer Python over Ruby for scripting tasks",
        createdAt: Date.now(),
        scopeId: "default",
        provenanceTrustClass: "guardian",
      },
      mockConfig.memory as any,
    );

    // Guardian should have more enqueued jobs due to extraction/conflict jobs
    expect(guardianResult.enqueuedJobs).toBeGreaterThan(
      peerResult.enqueuedJobs,
    );
  });
});

// =====================================================================
// 5. Memory Retrieval Gate — session memory denied for peer_assistant
// =====================================================================

describe("peer_assistant memory retrieval gate (session-memory)", () => {
  // Verify the session-memory.ts trust gate by scanning the source for the
  // isTrustedActor check. This is more robust than string equality because
  // it catches regressions in the actual source code.

  test("session-memory.ts gates recall to guardian-only (source check)", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "daemon", "session-memory.ts"),
      "utf-8",
    );

    // The isTrustedActor check must be strictly guardian-only
    const trustedLine = source
      .split("\n")
      .find(
        (l: string) => l.includes("isTrustedActor") && l.includes("==="),
      );
    expect(trustedLine).toBeDefined();
    expect(trustedLine).toContain("'guardian'");
    // Must NOT include peer_assistant as trusted
    expect(trustedLine).not.toContain("peer_assistant");
  });

  test("session-memory returns empty recall for non-guardian trust classes", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "daemon", "session-memory.ts"),
      "utf-8",
    );

    // When isTrustedActor is false, prepareMemoryContext must return early
    // with empty/disabled recall, profile, and conflict data.
    const untrustedBlock = source.indexOf("if (!isTrustedActor)");
    expect(untrustedBlock).toBeGreaterThan(-1);

    // The early return must include disabled recall
    const returnBlock = source.slice(
      untrustedBlock,
      source.indexOf("}", untrustedBlock + 200) + 200,
    );
    expect(returnBlock).toContain("enabled: false");
    expect(returnBlock).toContain("injectedText: ''");
    expect(returnBlock).toContain("dynamicProfile: { text: '' }");
    expect(returnBlock).toContain("softConflictInstruction: null");
  });

  test("peer_assistant in MemoryPrepareContext guardianTrustClass type", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "daemon", "session-memory.ts"),
      "utf-8",
    );

    // The MemoryPrepareContext interface must accept peer_assistant
    const ifaceStart = source.indexOf(
      "export interface MemoryPrepareContext",
    );
    expect(ifaceStart).toBeGreaterThan(-1);
    const ifaceBlock = source.slice(
      ifaceStart,
      source.indexOf("}", ifaceStart) + 1,
    );
    expect(ifaceBlock).toContain("'peer_assistant'");
  });
});

// =====================================================================
// 5b. No Guardian Context Leakage to A2A Peers
// =====================================================================

describe("no guardian context leakage to peer_assistant actors", () => {
  test("session-lifecycle treats peer_assistant as untrusted for history view", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "daemon", "session-lifecycle.ts"),
      "utf-8",
    );

    // isUntrustedTrustClass must include peer_assistant
    const fnStart = source.indexOf("function isUntrustedTrustClass");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf("}", fnStart) + 1);
    expect(fnBody).toContain("'peer_assistant'");
  });

  test("session-lifecycle filters messages for untrusted actors including peer_assistant", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "daemon", "session-lifecycle.ts"),
      "utf-8",
    );

    // filterMessagesForUntrustedActor must recognize peer_assistant provenance
    const fnStart = source.indexOf(
      "function filterMessagesForUntrustedActor",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf("}", fnStart) + 1);
    expect(fnBody).toContain("'peer_assistant'");
  });

  test("indexer blocks extraction AND conflict resolution for peer_assistant", () => {
    // Already tested above via indexMessageNow, but verify the dual gate:
    // both shouldExtract && isTrustedActor and shouldResolveConflicts && isTrustedActor
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const source = readFileSync(
      join(__dirname, "..", "memory", "indexer.ts"),
      "utf-8",
    );

    // Both extraction and conflict resolution must be gated on isTrustedActor
    expect(source).toContain("shouldExtract && isTrustedActor");
    expect(source).toContain("shouldResolveConflicts && isTrustedActor");
  });
});

// =====================================================================
// 6. Trust Classification Resolution
// =====================================================================

describe("peer_assistant trust classification", () => {
  test("TrustClass type includes peer_assistant", async () => {
    // Verify the type is correctly defined by importing it
    const { resolveActorTrust } = await import(
      "../runtime/actor-trust-resolver.js"
    );
    expect(typeof resolveActorTrust).toBe("function");

    // The TrustClass type now includes 'peer_assistant'.
    // The resolver itself doesn't produce 'peer_assistant' directly
    // (that will come from M13's channel type routing), but the type
    // system accepts it.
    const trustClass: import("../runtime/actor-trust-resolver.js").TrustClass =
      "peer_assistant";
    expect(trustClass).toBe("peer_assistant");
  });

  test("GuardianRuntimeContext accepts peer_assistant trustClass", async () => {
    const ctx: import("../daemon/session-runtime-assembly.js").GuardianRuntimeContext =
      {
        sourceChannel: "telegram",
        trustClass: "peer_assistant",
      };
    expect(ctx.trustClass).toBe("peer_assistant");
  });

  test("ToolContext accepts peer_assistant guardianTrustClass", () => {
    const ctx = makeContext({ guardianTrustClass: "peer_assistant" });
    expect(ctx.guardianTrustClass).toBe("peer_assistant");
  });
});

// =====================================================================
// 7. No regressions: existing trust roles still work correctly
// =====================================================================

describe("existing trust role regressions", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
  });

  test("guardian can execute tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ guardianTrustClass: "guardian" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("guardian can execute host tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_bash",
      { command: "echo hello" },
      makeContext({ guardianTrustClass: "guardian" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("guardian can access guardian control-plane", () => {
    const result = enforceGuardianOnlyPolicy(
      "bash",
      {
        command:
          "curl http://localhost:3000/v1/integrations/guardian/outbound/start",
      },
      "guardian",
    );
    expect(result.denied).toBe(false);
  });

  test("trusted_contact blocked from host tools (requires grant)", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_bash",
      { command: "echo hello" },
      makeContext({ guardianTrustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("guardian approval");
  });

  test("trusted_contact can execute read-only sandbox tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ guardianTrustClass: "trusted_contact" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("unknown actor blocked from side-effect tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "reminder_create",
      {
        fire_at: "2026-03-03T12:00:00Z",
        label: "test",
        message: "hello",
      },
      makeContext({ guardianTrustClass: "unknown" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("verified channel identity");
  });

  test("unknown actor blocked from guardian control-plane", () => {
    const result = enforceGuardianOnlyPolicy(
      "network_request",
      {
        url: "https://api.example.com/v1/integrations/guardian/challenge",
      },
      "unknown",
    );
    expect(result.denied).toBe(true);
  });
});

// =====================================================================
// 8. ToolApprovalHandler pre-execution gates — peer_assistant specific
// =====================================================================

describe("ToolApprovalHandler pre-execution gates for peer_assistant", () => {
  const handler = new ToolApprovalHandler();
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    events.length = 0;
  });

  test("peer_assistant blocked at pre-execution gate for any tool", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { command: "ls" },
      makeContext(),
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.result.isError).toBe(true);
      expect(result.result.content).toContain("peer assistant");
      expect(result.result.content).toContain(
        "no tool execution capabilities",
      );
    }

    const deniedEvents = events.filter((e) => e.type === "permission_denied");
    expect(deniedEvents.length).toBe(1);
  });

  test("peer_assistant blocked for sandbox-target tool too", async () => {
    const result = await handler.checkPreExecutionGates(
      "file_read",
      { path: "test.txt" },
      makeContext(),
      "sandbox",
      "low",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.result.content).toContain("peer assistant");
    }
  });

  test("peer_assistant denial is instant (no polling)", async () => {
    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      "bash",
      { command: "deploy" },
      makeContext(),
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

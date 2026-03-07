import type * as net from "node:net";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

let mockConfig = {
  provider: "mock-provider",
  providerOrder: ["mock-provider"],
  maxTokens: 4096,
  thinking: false,
  contextWindow: {
    maxInputTokens: 100000,
    thresholdTokens: 80000,
    preserveRecentMessages: 6,
    summaryModel: "mock-model",
    maxSummaryTokens: 512,
  },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
};

let initializeProvidersCalls = 0;

mock.module("node:child_process", () => ({
  execSync: () => "1920x1080",
  execFileSync: () => "",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/daemon-lifecycle-test.sock",
  getSessionTokenPath: () => "/tmp/daemon-lifecycle-test-token",
  getRootDir: () => "/tmp/daemon-lifecycle-test",
  getWorkspaceDir: () => "/tmp/daemon-lifecycle-test/workspace",
  getWorkspaceSkillsDir: () => "/tmp/daemon-lifecycle-test/workspace/skills",
  getSandboxWorkingDir: () => "/tmp/workspace",
  removeSocketFile: () => {},
  getTCPPort: () => 0,
  getTCPHost: () => "127.0.0.1",
  isTCPEnabled: () => false,
  isIOSPairingEnabled: () => false,
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  getFailoverProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {
    initializeProvidersCalls++;
  },
}));

mock.module("../providers/ratelimit.js", () => ({
  RateLimitProvider: class {
    constructor(..._args: unknown[]) {}
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
  validateAllowlistFile: () => [],
}));

mock.module("../memory/external-conversation-store.js", () => ({
  getBindingsForConversations: () => new Map(),
}));

const conversation = {
  id: "conv-1",
  title: "Test Conversation",
  updatedAt: Date.now(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCost: 0,
  threadType: "standard" as string,
  memoryScopeId: "default" as string,
};

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  createConversation: () => conversation,
  getConversation: (id: string) =>
    id === conversation.id ? conversation : null,
  getConversationThreadType: () => "standard",
  getConversationMemoryScopeId: () => "default",
  getMessages: () => [],
}));

mock.module("../memory/conversation-queries.js", () => ({
  getLatestConversation: () => conversation,
  listConversations: () => [conversation],
  countConversations: () => 1,
}));

class MockSession {
  public readonly conversationId: string;
  public memoryPolicy: unknown;
  private stale = false;
  private processing = false;
  public disposed = false;

  constructor(conversationId: string, ..._args: unknown[]) {
    this.conversationId = conversationId;
  }

  async loadFromDb(): Promise<void> {}
  async ensureActorScopedHistory(): Promise<void> {}
  updateClient(): void {}
  setSandboxOverride(): void {}
  isProcessing(): boolean {
    return this.processing;
  }
  isStale(): boolean {
    return this.stale;
  }
  markStale(): void {
    this.stale = true;
  }
  abort(): void {}
  dispose(): void {
    this.disposed = true;
  }
  hasEscalationHandler(): boolean {
    return true;
  }
  setEscalationHandler(): void {}
  handleConfirmationResponse(): void {}
  async processMessage(): Promise<void> {}
  undo(): number {
    return 1;
  }

  // Test helpers
  _setProcessing(v: boolean): void {
    this.processing = v;
  }
}

mock.module("../daemon/session.js", () => ({
  Session: MockSession,
  DEFAULT_MEMORY_POLICY: {
    scopeId: "default",
    includeDefaultFallback: false,
    strictSideEffects: false,
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { createMessageParser, serialize } from "../daemon/ipc-protocol.js";
import { DaemonServer } from "../daemon/server.js";
import {
  type EvictableSession,
  SessionEvictor,
} from "../daemon/session-evictor.js";

// ── Test Helpers ─────────────────────────────────────────────────────

type DaemonServerInternals = {
  sessions: Map<string, MockSession>;
  connectedSockets: Set<net.Socket>;
  authenticatedSockets: Set<net.Socket>;
  socketToSession: Map<net.Socket, string>;
  handleConnection: (socket: net.Socket) => void;
  sendInitialSession: (socket: net.Socket) => Promise<void>;
  dispatchMessage: (
    msg: { type: string; [key: string]: unknown },
    socket: net.Socket,
  ) => void;
  refreshConfigFromSources: () => boolean;
  evictSessionsForReload: () => void;
  lastConfigFingerprint: string;
  evictor: SessionEvictor;
};

function internals(server: DaemonServer): DaemonServerInternals {
  return server as unknown as DaemonServerInternals;
}

function createFakeSocket(overrides?: Partial<net.Socket>) {
  const writes: string[] = [];
  const base: Record<string, unknown> = {
    destroyed: false,
    writable: true,
    remoteAddress: "127.0.0.1",
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    destroy(): void {
      base.destroyed = true;
    },
    on(_event: string, _handler: (...args: unknown[]) => void): unknown {
      return socket;
    },
    once(_event: string, _handler: (...args: unknown[]) => void): unknown {
      return socket;
    },
    ...overrides,
  };
  const socket = base as unknown as net.Socket;
  return { socket, writes };
}

function decodeMessages(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createMockEvictableSession(
  processing = false,
): EvictableSession & { disposed: boolean } {
  return {
    disposed: false,
    isProcessing() {
      return processing;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("DaemonServer lifecycle", () => {
  beforeEach(() => {
    initializeProvidersCalls = 0;
    mockConfig = {
      provider: "mock-provider",
      providerOrder: ["mock-provider"],
      maxTokens: 4096,
      thinking: false,
      contextWindow: {
        maxInputTokens: 100000,
        thresholdTokens: 80000,
        preserveRecentMessages: 6,
        summaryModel: "mock-model",
        maxSummaryTokens: 512,
      },
      rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    };
  });

  describe("server stop", () => {
    test("stop disposes all sessions and clears state", async () => {
      const server = new DaemonServer();
      const int = internals(server);

      // Manually inject some sessions
      const s1 = new MockSession("sess-1");
      const s2 = new MockSession("sess-2");
      int.sessions.set("sess-1", s1);
      int.sessions.set("sess-2", s2);

      const { socket: sock1 } = createFakeSocket();
      const { socket: sock2 } = createFakeSocket();
      int.connectedSockets.add(sock1);
      int.connectedSockets.add(sock2);

      await server.stop();

      expect(s1.disposed).toBe(true);
      expect(s2.disposed).toBe(true);
      expect(int.sessions.size).toBe(0);
      expect(int.connectedSockets.size).toBe(0);
    });

    test("stop is idempotent when no server is listening", async () => {
      const server = new DaemonServer();
      // Should not throw even if start() was never called
      await server.stop();
    });
  });

  describe("config reload", () => {
    test("refreshConfigFromSources is a no-op when fingerprint is unchanged", () => {
      const server = new DaemonServer();
      const int = internals(server);

      // Set the fingerprint to match current config
      int.lastConfigFingerprint = JSON.stringify(mockConfig);

      const changed = int.refreshConfigFromSources();
      expect(changed).toBe(false);
    });

    test("refreshConfigFromSources detects config change and reinitializes providers", () => {
      const server = new DaemonServer();
      const int = internals(server);

      // Set to a different fingerprint to simulate previous config
      int.lastConfigFingerprint = '{"different": "config"}';
      const callsBefore = initializeProvidersCalls;

      const changed = int.refreshConfigFromSources();

      expect(changed).toBe(true);
      expect(initializeProvidersCalls).toBe(callsBefore + 1);
    });

    test("config change evicts non-processing sessions", () => {
      const server = new DaemonServer();
      const int = internals(server);

      const idle = new MockSession("idle");
      const busy = new MockSession("busy");
      busy._setProcessing(true);
      int.sessions.set("idle", idle);
      int.sessions.set("busy", busy);

      // Force a fingerprint mismatch — first set initial fingerprint
      int.lastConfigFingerprint = '{"old": true}';

      int.refreshConfigFromSources();

      // Idle session should be disposed and removed
      expect(idle.disposed).toBe(true);
      expect(int.sessions.has("idle")).toBe(false);

      // Busy session should be marked stale but kept
      expect(busy.disposed).toBe(false);
      expect(int.sessions.has("busy")).toBe(true);
      expect(busy.isStale()).toBe(true);
    });

    test("first config init does not evict sessions", () => {
      const server = new DaemonServer();
      const int = internals(server);

      const s1 = new MockSession("s1");
      int.sessions.set("s1", s1);

      // Empty fingerprint = first init
      int.lastConfigFingerprint = "";

      int.refreshConfigFromSources();

      // Should not evict on first init
      expect(s1.disposed).toBe(false);
      expect(int.sessions.has("s1")).toBe(true);
    });
  });

  describe("session eviction for reload", () => {
    test("evictSessionsForReload disposes idle and marks processing as stale", () => {
      const server = new DaemonServer();
      const int = internals(server);

      const idle1 = new MockSession("idle1");
      const idle2 = new MockSession("idle2");
      const busy1 = new MockSession("busy1");
      busy1._setProcessing(true);
      int.sessions.set("idle1", idle1);
      int.sessions.set("idle2", idle2);
      int.sessions.set("busy1", busy1);

      int.evictSessionsForReload();

      expect(idle1.disposed).toBe(true);
      expect(idle2.disposed).toBe(true);
      expect(int.sessions.has("idle1")).toBe(false);
      expect(int.sessions.has("idle2")).toBe(false);

      expect(busy1.disposed).toBe(false);
      expect(int.sessions.has("busy1")).toBe(true);
      expect(busy1.isStale()).toBe(true);
    });
  });

  describe("clearAllSessions", () => {
    test("disposes and removes every session unconditionally", () => {
      const server = new DaemonServer();
      const int = internals(server);

      const s1 = new MockSession("s1");
      const s2 = new MockSession("s2");
      s2._setProcessing(true);
      int.sessions.set("s1", s1);
      int.sessions.set("s2", s2);

      const count = server.clearAllSessions();

      expect(count).toBe(2);
      expect(s1.disposed).toBe(true);
      expect(s2.disposed).toBe(true);
      expect(int.sessions.size).toBe(0);
    });
  });
});

describe("IPC connection limits", () => {
  test("rejects connections when at MAX_CONNECTIONS", () => {
    const server = new DaemonServer();
    const int = internals(server);

    // Fill up to 50 connections
    for (let i = 0; i < 50; i++) {
      const { socket } = createFakeSocket();
      int.connectedSockets.add(socket);
    }

    // 51st connection should be rejected
    const { socket: rejected, writes } = createFakeSocket();
    int.handleConnection(rejected);

    const messages = decodeMessages(writes);
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain("Connection limit reached");
    expect(rejected.destroyed).toBe(true);
  });

  test("accepts connections when below MAX_CONNECTIONS", () => {
    const server = new DaemonServer();
    const int = internals(server);

    // Fill to 49
    for (let i = 0; i < 49; i++) {
      const { socket } = createFakeSocket();
      int.connectedSockets.add(socket);
    }

    // 50th should be accepted (at limit, not over)
    const { socket: accepted } = createFakeSocket();
    int.handleConnection(accepted);

    expect(accepted.destroyed).toBeFalsy();
    expect(int.connectedSockets.has(accepted)).toBe(true);
  });
});

describe("SessionEvictor — advanced scenarios", () => {
  let sessions: Map<string, EvictableSession & { disposed: boolean }>;

  beforeEach(() => {
    sessions = new Map();
  });

  describe("shouldProtect guard", () => {
    test("protected sessions are never evicted by TTL", () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          ttlMs: 100,
          maxSessions: 100,
          memoryThresholdBytes: Number.MAX_SAFE_INTEGER,
          sweepIntervalMs: 60_000,
        },
      );
      evictor.shouldProtect = (id) => id === "protected";

      const protectedSession = createMockEvictableSession();
      const normalSession = createMockEvictableSession();
      sessions.set("protected", protectedSession);
      sessions.set("normal", normalSession);

      // Both are never touched, so both exceed TTL

      const result = evictor.sweep();

      expect(result.ttlEvicted).toBe(1);
      expect(result.skipped).toBe(1);
      expect(protectedSession.disposed).toBe(false);
      expect(normalSession.disposed).toBe(true);
      expect(sessions.has("protected")).toBe(true);
      expect(sessions.has("normal")).toBe(false);
    });

    test("protected sessions are never evicted by LRU", () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          ttlMs: Number.MAX_SAFE_INTEGER,
          maxSessions: 1,
          memoryThresholdBytes: Number.MAX_SAFE_INTEGER,
          sweepIntervalMs: 60_000,
        },
      );
      evictor.shouldProtect = (id) => id === "protected";

      const protectedSession = createMockEvictableSession();
      const normalSession = createMockEvictableSession();
      sessions.set("protected", protectedSession);
      sessions.set("normal", normalSession);
      evictor.touch("protected");
      evictor.touch("normal");

      // Make protected the oldest
      const lastAccess = (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess;
      lastAccess.set("protected", Date.now() - 10000);

      const result = evictor.sweep();

      // Normal should be evicted even though protected is older
      expect(result.lruEvicted).toBe(1);
      expect(protectedSession.disposed).toBe(false);
      expect(normalSession.disposed).toBe(true);
    });
  });

  describe("combined phases", () => {
    test("TTL and LRU phases combine correctly", () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          ttlMs: 500,
          maxSessions: 2,
          memoryThresholdBytes: Number.MAX_SAFE_INTEGER,
          sweepIntervalMs: 60_000,
        },
      );

      // Create 4 sessions, 2 expired and 2 fresh
      for (let i = 0; i < 4; i++) {
        const s = createMockEvictableSession();
        sessions.set(`s${i}`, s);
        evictor.touch(`s${i}`);
      }

      const lastAccess = (
        evictor as unknown as { lastAccess: Map<string, number> }
      ).lastAccess;
      const now = Date.now();
      // s0 and s1 are expired
      lastAccess.set("s0", now - 1000);
      lastAccess.set("s1", now - 900);
      // s2 and s3 are fresh
      lastAccess.set("s2", now);
      lastAccess.set("s3", now);

      const result = evictor.sweep();

      // s0, s1 evicted by TTL; s2, s3 remain (at maxSessions=2, no LRU needed)
      expect(result.ttlEvicted).toBe(2);
      expect(result.lruEvicted).toBe(0);
      expect(sessions.size).toBe(2);
      expect(sessions.has("s2")).toBe(true);
      expect(sessions.has("s3")).toBe(true);
    });

    test("all processing sessions are fully skipped across phases", () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          ttlMs: 100,
          maxSessions: 1,
          memoryThresholdBytes: Number.MAX_SAFE_INTEGER,
          sweepIntervalMs: 60_000,
        },
      );

      // 3 processing sessions, all expired
      for (let i = 0; i < 3; i++) {
        const s = createMockEvictableSession(true);
        sessions.set(`s${i}`, s);
      }

      const result = evictor.sweep();

      expect(result.ttlEvicted).toBe(0);
      expect(result.lruEvicted).toBe(0);
      expect(result.skipped).toBe(3);
      expect(sessions.size).toBe(3);
    });
  });

  describe("evictor start/stop lifecycle", () => {
    test("start begins periodic sweeps, stop clears them", async () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          ttlMs: 10,
          maxSessions: 100,
          memoryThresholdBytes: Number.MAX_SAFE_INTEGER,
          sweepIntervalMs: 50,
        },
      );

      const s1 = createMockEvictableSession();
      sessions.set("s1", s1);
      // Never touched — will be expired immediately

      evictor.start();

      // Wait for at least one sweep
      await new Promise((r) => setTimeout(r, 120));

      expect(s1.disposed).toBe(true);
      expect(sessions.has("s1")).toBe(false);

      evictor.stop();
    });

    test("start is idempotent (calling twice does not create duplicate timers)", () => {
      const evictor = new SessionEvictor(
        sessions as Map<string, EvictableSession>,
        {
          sweepIntervalMs: 60_000,
        },
      );

      evictor.start();
      evictor.start(); // should be no-op

      // Verify by accessing internals — only one timer should exist
      const timer = (evictor as unknown as { sweepTimer: unknown }).sweepTimer;
      expect(timer).toBeDefined();

      evictor.stop();
    });
  });
});

describe("IPC protocol", () => {
  describe("serialize", () => {
    test("appends newline to JSON", () => {
      const result = serialize({ type: "ping" } as never);
      expect(result).toBe('{"type":"ping"}\n');
    });
  });

  describe("createMessageParser", () => {
    test("parses complete messages terminated by newline", () => {
      const parser = createMessageParser();
      const messages = parser.feed('{"type":"ping"}\n');
      expect(messages).toHaveLength(1);
      expect((messages[0] as unknown as Record<string, unknown>).type).toBe(
        "ping",
      );
    });

    test("buffers partial messages until newline arrives", () => {
      const parser = createMessageParser();

      const partial1 = parser.feed('{"type":');
      expect(partial1).toHaveLength(0);

      const partial2 = parser.feed('"ping"}\n');
      expect(partial2).toHaveLength(1);
      expect((partial2[0] as unknown as Record<string, unknown>).type).toBe(
        "ping",
      );
    });

    test("handles multiple messages in a single chunk", () => {
      const parser = createMessageParser();
      const messages = parser.feed('{"type":"ping"}\n{"type":"pong"}\n');
      expect(messages).toHaveLength(2);
      expect((messages[0] as unknown as Record<string, unknown>).type).toBe(
        "ping",
      );
      expect((messages[1] as unknown as Record<string, unknown>).type).toBe(
        "pong",
      );
    });

    test("skips malformed JSON lines gracefully", () => {
      const parser = createMessageParser();
      const messages = parser.feed('not json\n{"type":"valid"}\n');
      expect(messages).toHaveLength(1);
      expect((messages[0] as unknown as Record<string, unknown>).type).toBe(
        "valid",
      );
    });

    test("throws when line exceeds maxLineSize", () => {
      const parser = createMessageParser({ maxLineSize: 50 });

      expect(() => {
        // Feed a partial message that exceeds the limit without a newline
        parser.feed("a".repeat(51));
        // Trigger the size check by feeding more data
        parser.feed("\n");
      }).toThrow(/maximum line size/);
    });

    test("handles empty lines between messages", () => {
      const parser = createMessageParser();
      const messages = parser.feed('{"type":"a"}\n\n\n{"type":"b"}\n');
      expect(messages).toHaveLength(2);
    });
  });
});

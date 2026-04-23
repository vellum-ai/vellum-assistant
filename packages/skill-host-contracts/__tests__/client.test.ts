/**
 * Transport-level integration tests for `SkillHostClient`.
 *
 * The contracts package must not depend on `assistant/` (that's what the
 * whole skill-isolation effort is protecting). To exercise the client
 * end-to-end without the real `SkillIpcServer`, the harness here stands up
 * a minimal Unix-domain echo server that speaks the same JSON-lines
 * protocol documented in `skill-server.ts`. It understands enough of the
 * wire format to:
 *
 *   - dispatch `host.identity.*`, `host.platform.*`, `host.log`,
 *     `host.memory.addMessage`, `host.events.publish`, and the
 *     `host.events.subscribe` / `host.events.subscribe.close` stream
 *     methods the client uses in the `SkillHost` surface
 *   - fake a remote error for a method that the test asks it to reject
 *   - deliver a sequence of stream frames back to a subscriber
 *
 * Verifying the contract against a real `SkillIpcServer` lives in the
 * assistant package's own end-to-end tests (PR 25 acceptance).
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SkillHostClient } from "../src/client.js";

// ---------------------------------------------------------------------------
// Stand-in server
// ---------------------------------------------------------------------------

type Request = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type Response =
  | { id: string; result: unknown }
  | { id: string; error: string }
  | { id: string; event: "delivery"; payload: unknown };

type Handler = (params?: Record<string, unknown>) =>
  | unknown
  | Promise<unknown>;

interface StreamContext {
  id: string;
  send: (payload: unknown) => void;
  close: () => void;
}

type StreamHandler = (
  stream: StreamContext,
  params?: Record<string, unknown>,
) => () => void;

class StubServer {
  server: Server;
  clients = new Set<Socket>();
  streamDisposers = new Map<Socket, Map<string, () => void>>();
  methods = new Map<string, Handler>();
  streamMethods = new Map<string, StreamHandler>();
  observedRequests: Request[] = [];

  constructor(private socketPath: string) {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.handle(socket, line);
        }
      });
      socket.on("close", () => {
        this.clients.delete(socket);
        const disposers = this.streamDisposers.get(socket);
        if (disposers) {
          for (const d of disposers.values()) {
            try {
              d();
            } catch {
              /* ignore */
            }
          }
          this.streamDisposers.delete(socket);
        }
      });
      socket.on("error", () => {
        /* ignore */
      });
    });
  }

  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  register(method: string, handler: Handler): void {
    this.methods.set(method, handler);
  }

  registerStreaming(method: string, handler: StreamHandler): void {
    this.streamMethods.set(method, handler);
  }

  private send(socket: Socket, frame: Response): void {
    if (!socket.destroyed) socket.write(JSON.stringify(frame) + "\n");
  }

  private handle(socket: Socket, line: string): void {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      this.send(socket, { id: "unknown", error: "bad json" });
      return;
    }
    this.observedRequests.push(req);

    if (req.method === "host.events.subscribe.close") {
      const subscribeId =
        typeof req.params?.subscribeId === "string"
          ? req.params.subscribeId
          : null;
      if (subscribeId) {
        const map = this.streamDisposers.get(socket);
        const dispose = map?.get(subscribeId);
        if (dispose) {
          dispose();
          map!.delete(subscribeId);
        }
      }
      this.send(socket, { id: req.id, result: { closed: true } });
      return;
    }

    const streaming = this.streamMethods.get(req.method);
    if (streaming) {
      const ctx: StreamContext = {
        id: req.id,
        send: (payload) =>
          this.send(socket, { id: req.id, event: "delivery", payload }),
        close: () => {
          const map = this.streamDisposers.get(socket);
          const d = map?.get(req.id);
          if (d) {
            d();
            map!.delete(req.id);
          }
        },
      };
      const dispose = streaming(ctx, req.params);
      let map = this.streamDisposers.get(socket);
      if (!map) {
        map = new Map();
        this.streamDisposers.set(socket, map);
      }
      map.set(req.id, dispose);
      this.send(socket, { id: req.id, result: { subscribed: true } });
      return;
    }

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.send(socket, { id: req.id, error: `unknown method: ${req.method}` });
      return;
    }
    void (async () => {
      try {
        const r = await handler(req.params);
        this.send(socket, { id: req.id, result: r });
      } catch (err) {
        this.send(socket, { id: req.id, error: String(err) });
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir = "";
let socketPath = "";
let server: StubServer | null = null;
let client: SkillHostClient | null = null;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-host-client-test-"));
  socketPath = join(tempDir, "assistant-skill.sock");
  server = new StubServer(socketPath);
  // Standard identity/platform/log stubs every test relies on for
  // `connect()` to succeed.
  server.register("host.identity.getInternalAssistantId", () => "self");
  server.register(
    "host.identity.getAssistantName",
    () => "Example Assistant",
  );
  server.register("host.platform.workspaceDir", () => "/tmp/workspace");
  server.register("host.platform.vellumRoot", () => "/tmp/vellum");
  server.register("host.platform.runtimeMode", () => "bare-metal");
  server.register("host.log", () => ({ ok: true }));
  await server.start();
});

afterEach(async () => {
  client?.close();
  client = null;
  await server?.stop();
  server = null;
  rmSync(tempDir, { recursive: true, force: true });
});

async function openClient(
  overrides: Partial<ConstructorParameters<typeof SkillHostClient>[0]> = {},
): Promise<SkillHostClient> {
  const c = new SkillHostClient({
    socketPath,
    skillId: "test-skill",
    ...overrides,
  });
  await c.connect();
  return c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillHostClient: bootstrap + sync accessors", () => {
  test("connect populates identity/platform caches", async () => {
    client = await openClient();
    expect(client.identity.internalAssistantId).toBe("self");
    expect(client.identity.getAssistantName()).toBe("Example Assistant");
    expect(client.platform.workspaceDir()).toBe("/tmp/workspace");
    expect(client.platform.vellumRoot()).toBe("/tmp/vellum");
    expect(client.platform.runtimeMode()).toBe("bare-metal");
  });

  test("sync accessors throw before connect()", () => {
    client = new SkillHostClient({
      socketPath,
      skillId: "test-skill",
    });
    expect(() => client!.identity.internalAssistantId).toThrow(/not connected/);
    expect(() => client!.platform.workspaceDir()).toThrow(/not connected/);
  });

  test("null assistant name normalizes to undefined", async () => {
    server!.register("host.identity.getAssistantName", () => null);
    client = await openClient();
    expect(client.identity.getAssistantName()).toBeUndefined();
  });
});

describe("SkillHostClient: async round-trips", () => {
  test("memory.addMessage forwards params and returns the result", async () => {
    let seen: Record<string, unknown> | undefined;
    server!.register("host.memory.addMessage", (params) => {
      seen = params;
      return { id: "msg-123" };
    });
    client = await openClient();
    const result = await client.memory.addMessage(
      "conv-1",
      "user",
      "hello",
      { channel: "ipc" },
      { skipIndexing: true },
    );
    expect(result).toEqual({ id: "msg-123" });
    expect(seen).toEqual({
      conversationId: "conv-1",
      role: "user",
      content: "hello",
      metadata: { channel: "ipc" },
      opts: { skipIndexing: true },
    });
  });

  test("secureKeys.getProviderKey round-trips", async () => {
    server!.register("host.providers.secureKeys.getProviderKey", (params) => {
      return params && params.id === "anthropic" ? "test-key" : null;
    });
    client = await openClient();
    await expect(client.providers.secureKeys.getProviderKey("anthropic")).resolves.toBe(
      "test-key",
    );
    await expect(client.providers.secureKeys.getProviderKey("absent")).resolves.toBeNull();
  });

  test("remote error is surfaced as a thrown Error", async () => {
    server!.register("host.memory.wakeAgentForOpportunity", () => {
      throw new Error("wake failed");
    });
    client = await openClient();
    await expect(
      client.memory.wakeAgentForOpportunity({
        conversationId: "c",
        hint: "h",
        source: "s",
      } as never),
    ).rejects.toThrow(/wake failed/);
  });

  test("events.publish round-trips", async () => {
    let capturedEvent: unknown;
    server!.register("host.events.publish", (params) => {
      capturedEvent = (params as { event: unknown }).event;
      return { published: true };
    });
    client = await openClient();
    const event = {
      id: "evt-1",
      assistantId: "self",
      emittedAt: "2024-01-01T00:00:00.000Z",
      message: { type: "demo" },
    };
    await client.events.publish(event as never);
    expect(capturedEvent).toEqual(event as typeof capturedEvent);
  });

  test("rawCall escape hatch forwards arbitrary methods", async () => {
    server!.register("host.config.getSection", (params) => {
      return params && params.path === "llm.default"
        ? { provider: "anthropic" }
        : null;
    });
    client = await openClient();
    await expect(
      client.rawCall("host.config.getSection", { path: "llm.default" }),
    ).resolves.toEqual({ provider: "anthropic" });
  });
});

describe("SkillHostClient: events.subscribe", () => {
  test("open ack, delivery, and explicit dispose", async () => {
    const delivered: unknown[] = [];
    const streamBox: { current: StreamContext | null } = { current: null };
    server!.registerStreaming(
      "host.events.subscribe",
      (stream, _params) => {
        streamBox.current = stream;
        return () => {
          streamBox.current = null;
        };
      },
    );
    client = await openClient();

    const sub = client.events.subscribe(
      { assistantId: "self" },
      (evt) => {
        delivered.push(evt);
      },
    );

    // Wait for the server to open the stream.
    await new Promise((r) => setTimeout(r, 30));
    expect(streamBox.current).not.toBeNull();

    streamBox.current!.send({ id: "e1", type: "greeting" });
    streamBox.current!.send({ id: "e2", type: "parting" });

    // Allow deliveries to propagate.
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(2);
    expect((delivered[0] as { id: string }).id).toBe("e1");

    expect(sub.active).toBe(true);
    sub.dispose();
    expect(sub.active).toBe(false);

    // After dispose, server-side stream handle should be released via
    // the close control message.
    await new Promise((r) => setTimeout(r, 30));
    expect(streamBox.current).toBeNull();
  });

  test("callback is not invoked after dispose() even if a late delivery races in", async () => {
    const delivered: unknown[] = [];
    const streamBox: { current: StreamContext | null } = { current: null };
    server!.registerStreaming("host.events.subscribe", (stream, _params) => {
      streamBox.current = stream;
      return () => {
        streamBox.current = null;
      };
    });
    client = await openClient();

    const sub = client.events.subscribe(
      { assistantId: "self" },
      (evt) => {
        delivered.push(evt);
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    sub.dispose();
    // Simulate a late delivery frame that was already in-flight. The
    // client should drop it silently.
    streamBox.current?.send({ id: "late", type: "post" });
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(0);
  });
});

describe("SkillHostClient: logger", () => {
  test("logger.get fires host.log with the provided scope", async () => {
    const logs: Array<Record<string, unknown>> = [];
    server!.register("host.log", (params) => {
      logs.push(params as Record<string, unknown>);
      return { ok: true };
    });
    client = await openClient();
    const logger = client.logger.get("test-module");
    logger.info("hello", { foo: "bar" });
    // Logger is fire-and-forget, so give the socket a moment to flush.
    await new Promise((r) => setTimeout(r, 30));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      level: "info",
      msg: "hello",
      name: "test-module",
      meta: { foo: "bar" },
    });
  });
});

describe("SkillHostClient: registries", () => {
  test("registerTools serializes the tool manifest", async () => {
    let captured: unknown;
    server!.register("host.registries.register_tools", (params) => {
      captured = params;
      return { registered: [(params as { tools: { name: string }[] }).tools[0]?.name] };
    });
    client = await openClient();
    client.registries.registerTools(() => [
      {
        name: "demo.tool",
        description: "demo",
        category: "misc",
        defaultRiskLevel: "low" as never,
        getDefinition: () => ({
          name: "demo.tool",
          description: "demo",
          input_schema: { type: "object" },
        }),
        execute: async () => ({ content: "", isError: false }),
      },
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toBeDefined();
    const tools = (captured as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("demo.tool");
  });

  test("registerShutdownHook forwards the name", async () => {
    let capturedName: string | undefined;
    server!.register("host.registries.register_shutdown_hook", (params) => {
      capturedName = (params as { name: string }).name;
      return { name: capturedName };
    });
    client = await openClient();
    client.registries.registerShutdownHook("demo-shutdown", async () => {
      // no-op
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(capturedName).toBe("demo-shutdown");
  });
});

describe("SkillHostClient: close() drains pending calls", () => {
  test("close rejects an in-flight call", async () => {
    server!.register("host.memory.addMessage", () => {
      // Never resolve.
      return new Promise(() => {});
    });
    client = await openClient();
    const call = client.memory.addMessage("c", "u", "content");
    client.close();
    await expect(call).rejects.toThrow(/closed/);
  });
});

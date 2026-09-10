import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { newFakeDesktop, newViewer, settle } from "./__tests__/fake-desktop.js";
import { DesktopDependencyInstaller } from "./desktop-dependencies.js";
import {
  type DesktopSessionManager,
  type DesktopTcpHandlers,
  type DesktopTcpSocket,
  destroyDesktopSessionManager,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";
import { DesktopStreamBridge } from "./desktop-stream-bridge.js";

const profileDir = mkdtempSync(join(tmpdir(), "desktop-bridge-test-"));
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

class FakeWs {
  readonly sent: Uint8Array[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  /** What `send` reports back; Bun returns 0 for a dropped frame. */
  sendResult: number | null = null;

  send(data: Uint8Array): number {
    this.sent.push(data);
    return this.sendResult ?? data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
  }
}

class FakeTcp implements DesktopTcpSocket {
  readonly writes: Uint8Array[] = [];
  ended = false;
  handlers!: DesktopTcpHandlers;

  write(data: Uint8Array): number {
    this.writes.push(data);
    return data.byteLength;
  }

  end(): void {
    this.ended = true;
  }
}

function newBridge(
  manager: DesktopSessionManager,
  ensureInstalled: () => Promise<void> = async () => {},
) {
  const ws = new FakeWs();
  const tcp = new FakeTcp();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = new DesktopStreamBridge(ws, {
    manager,
    ensureInstalled,
    connect: async (_port, handlers) => {
      tcp.handlers = handlers;
      await gate;
      return tcp;
    },
  });
  return { ws, tcp, bridge, connectNow: () => release!() };
}

/** Whether the manager's viewer slot is free, observed through acquire. */
function slotIsFree(manager: DesktopSessionManager): boolean {
  const { viewer } = newViewer();
  const result = manager.acquireViewerSlot(viewer);
  if (result.ok) {
    manager.releaseViewerSlot(viewer);
  }
  return result.ok;
}

describe("DesktopStreamBridge", () => {
  test("direct viewers share background setup across a timeout and reconnect", async () => {
    const h = newFakeDesktop({ profileDir });
    let ready = false;
    let installs = 0;
    const install = Promise.withResolvers<void>();
    const installer = new DesktopDependencyInstaller({
      supported: () => true,
      ready: () => ready,
      install: async () => {
        installs++;
        await install.promise;
        ready = true;
      },
      notify: async () => {},
    });
    const ensureInstalled = () => installer.ensureReady();
    const first = newBridge(h.manager, ensureInstalled);
    const firstStart = first.bridge.start();
    await settle();
    expect(installs).toBe(1);
    expect(h.spawned).toEqual([]);

    const busy = newBridge(h.manager, async () => {
      throw new Error("A rejected viewer must not start setup");
    });
    await busy.bridge.start();
    expect(busy.ws.closeCode).toBe(4013);

    first.bridge.handleClose();
    expect(slotIsFree(h.manager)).toBe(true);
    const retry = newBridge(h.manager, ensureInstalled);
    const retryStart = retry.bridge.start();
    await settle();
    expect(installs).toBe(1);
    expect(h.spawned).toEqual([]);

    install.resolve();
    retry.connectNow();
    await Promise.all([firstStart, retryStart]);
    expect(retry.ws.closeCode).toBeNull();
    expect(h.spawned.length).toBeGreaterThan(0);
    retry.tcp.handlers.onData(new Uint8Array([1, 2, 3]));
    expect(retry.ws.sent).toEqual([new Uint8Array([1, 2, 3])]);
    expect(first.ws.sent).toEqual([]);
    expect(first.tcp.handlers).toBeUndefined();
    retry.bridge.handleClose();
  });

  test("setup continues after the last viewer closes without starting a desktop", async () => {
    const h = newFakeDesktop({ profileDir });
    const install = Promise.withResolvers<void>();
    const b = newBridge(h.manager, () => install.promise);
    const started = b.bridge.start();
    b.bridge.handleClose();
    install.resolve();
    await started;
    expect(h.spawned).toEqual([]);
    expect(slotIsFree(h.manager)).toBe(true);
  });

  test("setup failure releases the slot and permits a successful retry", async () => {
    const h = newFakeDesktop({ profileDir });
    let ready = false;
    let attempts = 0;
    const installer = new DesktopDependencyInstaller({
      supported: () => true,
      ready: () => ready,
      install: async () => {
        if (++attempts === 1) {
          throw new Error("Download failed");
        }
        ready = true;
      },
      notify: async () => {},
    });
    const ensureInstalled = () => installer.ensureReady();
    const first = newBridge(h.manager, ensureInstalled);
    await first.bridge.start();
    expect(first.ws.closeCode).toBe(4011);
    expect(slotIsFree(h.manager)).toBe(true);
    expect(h.spawned).toEqual([]);

    const retry = newBridge(h.manager, ensureInstalled);
    retry.connectNow();
    await retry.bridge.start();
    expect(attempts).toBe(2);
    expect(retry.ws.closeCode).toBeNull();
    retry.bridge.handleClose();
  });

  test("shutdown during setup closes the viewer without starting a desktop", async () => {
    const h = newFakeDesktop({ profileDir });
    const install = Promise.withResolvers<void>();
    const b = newBridge(h.manager, () => install.promise);
    const started = b.bridge.start();
    await h.manager.destroy();
    expect(b.ws.closeCode).toBe(1001);
    install.resolve();
    await started;
    expect(h.spawned).toEqual([]);
    expect(b.tcp.handlers).toBeUndefined();
  });

  test("pumps bytes both ways and flushes frames that beat the VNC socket", async () => {
    const h = newFakeDesktop({ profileDir });
    const b = newBridge(h.manager);
    const started = b.bridge.start();
    await settle();

    b.bridge.handleClientFrame(new Uint8Array([1, 2, 3]));
    b.bridge.handleClientFrame(new Uint8Array([4]).buffer);
    b.bridge.handleClientFrame("text frames are not RFB");
    expect(b.tcp.writes).toEqual([]);

    b.connectNow();
    await started;
    expect(b.tcp.writes).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
    ]);

    b.tcp.handlers.onData(new Uint8Array([9, 9]));
    expect(b.ws.sent).toEqual([new Uint8Array([9, 9])]);
    expect(b.ws.closeCode).toBeNull();
    expect(slotIsFree(h.manager)).toBe(false);

    b.bridge.handleClose();
    expect(b.tcp.ended).toBe(true);
    expect(slotIsFree(h.manager)).toBe(true);
  });

  test("a second socket closes 4013 and leaves the first untouched", async () => {
    const h = newFakeDesktop({ profileDir });
    const first = newBridge(h.manager);
    first.connectNow();
    await first.bridge.start();

    const second = newBridge(h.manager);
    await second.bridge.start();

    expect(second.ws.closeCode).toBe(4013);
    expect(first.ws.closeCode).toBeNull();

    second.bridge.handleClose();
    expect(slotIsFree(h.manager)).toBe(false);
  });

  test("closes 4011 when the desktop fails to start and frees the slot", async () => {
    const h = newFakeDesktop({ profileDir });
    h.setVncReady(false);
    const b = newBridge(h.manager);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(4011);
    expect(slotIsFree(h.manager)).toBe(true);
  });

  test("closes 4011 and frees the slot when the start rejects with a plain error", async () => {
    const h = newFakeDesktop({ profileDir });
    h.manager.ensureDesktopRunning = () =>
      Promise.reject(new Error("unexpected"));
    const b = newBridge(h.manager);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(4011);
    expect(b.ws.closeReason).toBe("Desktop failed to start");
    expect(slotIsFree(h.manager)).toBe(true);
  });

  test("closes 4011 when the desktop dies under the viewer", async () => {
    const h = newFakeDesktop({ profileDir });
    const b = newBridge(h.manager);
    b.connectNow();
    await b.bridge.start();
    await settle();

    h.child("window-manager").exit(1);
    await settle();

    expect(b.ws.closeCode).toBe(4011);
    expect(b.ws.closeReason).toContain("window-manager exited");
    expect(b.tcp.ended).toBe(true);
  });

  test("closes 4011 when the viewer drops a frame", async () => {
    const h = newFakeDesktop({ profileDir });
    const b = newBridge(h.manager);
    b.connectNow();
    await b.bridge.start();

    b.ws.sendResult = 0;
    b.tcp.handlers.onData(new Uint8Array([1]));

    expect(b.ws.closeCode).toBe(4011);
    expect(b.ws.closeReason).toBe("Viewer too slow");
    expect(b.tcp.ended).toBe(true);
    expect(slotIsFree(h.manager)).toBe(true);
  });

  test("closes 1001 for a socket arriving after shutdown began", async () => {
    const h = newFakeDesktop({ profileDir });
    await h.manager.destroy();
    const b = newBridge(h.manager);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(1001);
    expect(b.ws.closeReason).toBe("The assistant is shutting down");
    expect(h.spawned).toEqual([]);
  });

  test("the shared manager is latched by shutdown even when no desktop was ever served", async () => {
    await destroyDesktopSessionManager();

    const ws = new FakeWs();
    const bridge = new DesktopStreamBridge(ws, {
      connect: async () => {
        throw new Error("must not dial the VNC port");
      },
    });
    await bridge.start();

    expect(ws.closeCode).toBe(1001);
    // Nothing is spawned: the start is refused before any binary is looked up.
    await expect(
      getDesktopSessionManager().ensureDesktopRunning(),
    ).rejects.toThrow("Desktop ingress is closed");
  });

  test("closes a live viewer with 1001 when the runtime shuts down", async () => {
    const h = newFakeDesktop({ profileDir, exitOnTerm: true });
    const b = newBridge(h.manager);
    b.connectNow();
    await b.bridge.start();
    await settle();

    await h.manager.destroy();

    expect(b.ws.closeCode).toBe(1001);
    expect(b.ws.closeReason).toBe("The assistant is shutting down");
    expect(b.tcp.ended).toBe(true);
  });
});

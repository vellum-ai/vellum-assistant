import { BrowserWindow, app, type WebContents } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { handle } from "./ipc";
import log from "./logger";

export type HotkeyEventState = "down" | "up";

export interface HotkeyEvent {
  kind: "fnPushToTalk";
  state: HotkeyEventState;
}

export type FnPushToTalkResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

type PendingCall = {
  resolve: (result: FnPushToTalkResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const RESPONSE_TIMEOUT_MS = 2_000;
const SHUTDOWN_KILL_DELAY_MS = 500;

const HOTKEY_EVENT_SCHEMA = z.object({
  kind: z.literal("fnPushToTalk"),
  state: z.enum(["down", "up"]),
});

const HELPER_ENVELOPE_SCHEMA = z.union([
  z.object({
    event: z.literal("hotkey-event"),
    payload: HOTKEY_EVENT_SCHEMA,
  }),
  z.object({
    id: z.number(),
    ok: z.literal(true),
    result: z.object({ enabled: z.boolean().optional() }).optional(),
  }),
  z.object({
    id: z.number(),
    ok: z.literal(false),
    error: z.string().optional(),
  }),
]);

let platformForTesting: NodeJS.Platform | null = null;

const getPlatform = (): NodeJS.Platform =>
  platformForTesting ?? process.platform;

export const getHotkeyHelperPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "hotkey-helper");
  }
  return path.join(app.getAppPath(), "resources", "hotkey-helper");
};

class HotkeyHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: HotkeyEvent) => void>();
  private readonly exitListeners = new Set<() => void>();
  private fnIsDown = false;

  onEvent(listener: (event: HotkeyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult> {
    if (getPlatform() !== "darwin") {
      return { ok: false, reason: "Fn push-to-talk is only available on macOS" };
    }

    const child = this.ensureChild();
    if (!child) {
      return { ok: false, reason: "hotkey helper is not available" };
    }

    return this.call(child, "hotkey.fnPushToTalk", { enable });
  }

  shutdown(): void {
    if (!this.child) return;

    try {
      this.child.stdin.write(
        `${JSON.stringify({
          id: this.nextId++,
          method: "hotkey.fnPushToTalk",
          params: { enable: false },
        })}\n`,
      );
      this.child.stdin.end();
    } catch {
      // The process may already be gone. The exit handler resolves cleanup.
    }

    const child = this.child;
    const killTimer = setTimeout(() => {
      if (this.child === child) {
        child.kill();
      }
    }, SHUTDOWN_KILL_DELAY_MS);
    killTimer.unref?.();
  }

  __resetForTesting(): void {
    this.shutdown();
    this.child = null;
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.fnIsDown = false;
    this.listeners.clear();
    this.exitListeners.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, reason: `hotkey helper reset (${id})` });
    }
    this.pending.clear();
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child;

    const helperPath = getHotkeyHelperPath();
    if (!existsSync(helperPath)) {
      log.warn(`[hotkey-helper] executable not found at ${helperPath}`);
      return null;
    }

    try {
      const child = spawn(helperPath, [], { stdio: "pipe" });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) log.warn(`[hotkey-helper] ${line}`);
      });
      child.on("error", (err: Error) => {
        log.warn(`[hotkey-helper] failed to spawn: ${err.message}`);
        this.handleExit();
      });
      child.on("close", () => this.handleExit());
      return child;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[hotkey-helper] failed to spawn: ${message}`);
      return null;
    }
  }

  private call(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: Record<string, unknown>,
  ): Promise<FnPushToTalkResult> {
    const id = this.nextId++;
    return new Promise<FnPushToTalkResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "hotkey helper did not respond" });
      }, RESPONSE_TIMEOUT_MS);
      timeout.unref?.();

      this.pending.set(id, { resolve, timeout });
      const payload = `${JSON.stringify({ id, method, params })}\n`;
      child.stdin.write(payload, (err) => {
        if (!err) return;
        this.resolvePending(id, {
          ok: false,
          reason: `hotkey helper write failed: ${err.message}`,
        });
      });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn(`[hotkey-helper] ignored invalid JSON: ${line}`);
      return;
    }

    const envelope = HELPER_ENVELOPE_SCHEMA.safeParse(parsed);
    if (!envelope.success) {
      log.warn(`[hotkey-helper] ignored invalid envelope: ${line}`);
      return;
    }

    const message = envelope.data;
    if ("event" in message) {
      this.emitEvent(message.payload);
      return;
    }

    if (message.ok) {
      this.resolvePending(message.id, {
        ok: true,
        enabled: message.result?.enabled ?? false,
      });
    } else {
      this.resolvePending(message.id, {
        ok: false,
        reason: message.error ?? "hotkey helper returned an error",
      });
    }
  }

  private resolvePending(id: number, result: FnPushToTalkResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.resolve(result);
  }

  private emitEvent(event: HotkeyEvent): void {
    this.fnIsDown = event.state === "down";
    for (const listener of this.listeners) listener(event);
  }

  private handleExit(): void {
    const hadChild = this.child !== null;
    this.child = null;
    this.stdoutBuffer = "";

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: false,
        reason: `hotkey helper exited before response ${id}`,
      });
    }
    this.pending.clear();

    if (this.fnIsDown) {
      this.fnIsDown = false;
      for (const listener of this.listeners) {
        listener({ kind: "fnPushToTalk", state: "up" });
      }
    }

    if (hadChild) {
      for (const listener of this.exitListeners) listener();
    }
  }
}

const client = new HotkeyHelperClient();

interface HotkeyOwner {
  webContents: WebContents;
  cleanup: () => void;
}

const hotkeyOwners = new Map<number, HotkeyOwner>();
let activeHotkeyOwnerId: number | null = null;
let helperRegistered = false;

const newestOwnerId = (): number | null => {
  let id: number | null = null;
  for (const [ownerId, owner] of hotkeyOwners) {
    if (!owner.webContents.isDestroyed()) id = ownerId;
  }
  return id;
};

const removeHotkeyOwner = (webContentsId: number): void => {
  const owner = hotkeyOwners.get(webContentsId);
  if (!owner) return;
  owner.cleanup();
  hotkeyOwners.delete(webContentsId);
  if (activeHotkeyOwnerId === webContentsId) {
    activeHotkeyOwnerId = newestOwnerId();
  }
};

const disableFnPushToTalkForOwner = async (
  webContents: WebContents,
): Promise<FnPushToTalkResult> => {
  removeHotkeyOwner(webContents.id);

  if (hotkeyOwners.size > 0) {
    return { ok: true, enabled: true };
  }
  if (!helperRegistered) {
    return { ok: true, enabled: false };
  }

  const result = await client.fnPushToTalk(false);
  if (result.ok) helperRegistered = false;
  return result;
};

const addHotkeyOwner = (webContents: WebContents): void => {
  const id = webContents.id;
  if (hotkeyOwners.has(id)) {
    activeHotkeyOwnerId = id;
    return;
  }

  const win = BrowserWindow.fromWebContents(webContents);
  const markActive = () => {
    if (hotkeyOwners.has(id)) activeHotkeyOwnerId = id;
  };
  const handleDestroyed = () => {
    void disableFnPushToTalkForOwner(webContents);
  };

  webContents.once("destroyed", handleDestroyed);
  win?.on("focus", markActive);

  hotkeyOwners.set(id, {
    webContents,
    cleanup: () => {
      webContents.off("destroyed", handleDestroyed);
      win?.off("focus", markActive);
    },
  });
  activeHotkeyOwnerId = id;
};

const enableFnPushToTalkForOwner = async (
  webContents: WebContents,
): Promise<FnPushToTalkResult> => {
  addHotkeyOwner(webContents);

  if (helperRegistered) {
    return { ok: true, enabled: true };
  }

  const result = await client.fnPushToTalk(true);
  if (result.ok) {
    helperRegistered = result.enabled;
  } else {
    removeHotkeyOwner(webContents.id);
  }
  return result;
};

const sendHotkeyEventToOwner = (event: HotkeyEvent): void => {
  const ownerId = activeHotkeyOwnerId ?? newestOwnerId();
  const activeOwner = ownerId !== null ? hotkeyOwners.get(ownerId) : null;
  const owner =
    activeOwner && !activeOwner.webContents.isDestroyed()
      ? activeOwner
      : hotkeyOwners.get(newestOwnerId() ?? -1);
  if (!owner || owner.webContents.isDestroyed()) return;
  owner.webContents.send("vellum:helper:hotkey:event", event);
};

let installed = false;
export const installHotkeyHelper = (): void => {
  if (installed) return;
  installed = true;

  client.onEvent(sendHotkeyEventToOwner);
  client.onExit(() => {
    helperRegistered = false;
  });

  handle(
    "vellum:helper:hotkey:fnPushToTalk",
    z.tuple([z.boolean()]),
    ([enable], event) =>
      enable
        ? enableFnPushToTalkForOwner(event.sender)
        : disableFnPushToTalkForOwner(event.sender),
  );

  app.on("will-quit", () => {
    client.shutdown();
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  platformForTesting = null;
  helperRegistered = false;
  for (const owner of hotkeyOwners.values()) owner.cleanup();
  hotkeyOwners.clear();
  activeHotkeyOwnerId = null;
  client.__resetForTesting();
};

export const __setPlatformForTesting = (
  platform: NodeJS.Platform | null,
): void => {
  platformForTesting = platform;
};

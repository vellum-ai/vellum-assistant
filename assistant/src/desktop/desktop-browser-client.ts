import { browserManager } from "../tools/browser/browser-manager.js";
import {
  type CdpWsTransport,
  CdpWsTransportError,
} from "../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import { CdpError } from "../tools/browser/cdp-client/errors.js";
import type {
  ScopedCdpClient,
  TabInfo,
} from "../tools/browser/cdp-client/types.js";
import {
  desktopCursorExpression,
  REMOVE_DESKTOP_CURSOR,
} from "./desktop-browser-cursor.js";

type Target = { targetId: string; type: string; url: string; title: string };
type HeldInput = {
  targetId: string;
  method: string;
  params: Record<string, unknown>;
};

export class DesktopBrowserClient {
  private transport?: CdpWsTransport;
  private targets = new Map<number, string>();
  private sessions = new Map<string, string>();
  private selected?: number;
  private nextTab = 1;
  private held = new Map<string, HeldInput>();
  private conversation?: string;
  generation = 0;

  constructor(
    private readonly connect: (signal: AbortSignal) => Promise<CdpWsTransport>,
  ) {}

  invalidateSnapshot(): void {
    this.generation++;
    if (this.conversation) {
      browserManager.clearSnapshotBackendNodeMap(this.conversation);
    }
  }

  async client(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ScopedCdpClient> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    signal.throwIfAborted();
    if (!this.transport) {
      const transport = await this.connect(signal);
      if (signal.aborted) {
        transport.dispose();
        signal.throwIfAborted();
      }
      this.transport = transport;
      transport.addEventListener((event) => {
        if (
          [
            "Page.frameNavigated",
            "Page.navigatedWithinDocument",
            "DOM.documentUpdated",
            "Target.detachedFromTarget",
            "Target.targetDestroyed",
          ].includes(event.method)
        ) {
          this.invalidateSnapshot();
        }
        if (event.method === "Target.detachedFromTarget") {
          const detached = (event.params as { sessionId?: string })?.sessionId;
          for (const [target, session] of this.sessions) {
            if (session === detached) {
              this.sessions.delete(target);
            }
          }
        }
      });
    }
    this.conversation = `desktop-browser:${conversationId}`;
    const transport = this.transport;
    await this.session(transport, signal);
    const generation = this.generation;
    const activeSignal = (child?: AbortSignal) =>
      child ? AbortSignal.any([signal, child]) : signal;
    return {
      kind: "cdp-inspect",
      conversationId: this.conversation,
      send: <T>(
        method: string,
        params?: Record<string, unknown>,
        child?: AbortSignal,
      ) =>
        this.send<T>(
          transport,
          method,
          params ?? {},
          activeSignal(child),
          generation,
        ),
      listTabs: () => this.listTabs(transport, signal),
      selectTab: async (tabId) => {
        const tabs = await this.listTabs(transport, signal);
        const tab = tabs.find((item) => item.tabId === tabId);
        const targetId = this.targets.get(tabId);
        if (!tab || !targetId) {
          throw new Error("Desktop browser tab is unavailable");
        }
        await transport.send("Target.activateTarget", { targetId }, { signal });
        this.selected = tabId;
        this.invalidateSnapshot();
        return { ...tab, clientId: "managed-desktop" };
      },
      closeTab: async (tabId) => {
        const targetId = this.targets.get(tabId);
        if (!targetId) {
          throw new Error("Desktop browser tab is unavailable");
        }
        await transport.send("Target.closeTarget", { targetId }, { signal });
        if (this.selected === tabId) {
          this.selected = undefined;
        }
        this.invalidateSnapshot();
        return { closed: true, tabId, clientId: "managed-desktop" };
      },
      setCdpSessionId: (tabId) => {
        signal.throwIfAborted();
        if (this.transport !== transport) {
          throw new Error("Desktop browser session expired");
        }
        this.selected = tabId === undefined ? undefined : Number(tabId);
        this.invalidateSnapshot();
      },
      dispose: () => {},
    };
  }

  private async listTabs(
    transport: CdpWsTransport,
    signal: AbortSignal,
  ): Promise<TabInfo[]> {
    signal.throwIfAborted();
    if (this.transport !== transport) {
      throw new Error("Desktop browser session expired");
    }
    const { targetInfos } = await transport.send<{ targetInfos: Target[] }>(
      "Target.getTargets",
      {},
      { signal },
    );
    const pages = targetInfos.filter(
      (target) => target.type === "page" && !target.url.startsWith("devtools:"),
    );
    const liveTargets = new Set(pages.map((page) => page.targetId));
    for (const [id, target] of this.targets) {
      if (!liveTargets.has(target)) {
        this.targets.delete(id);
      }
    }
    const aliases = new Map(
      [...this.targets].map(([id, target]) => [target, id]),
    );
    return pages.map((target) => {
      let id = aliases.get(target.targetId);
      if (id === undefined) {
        id = this.nextTab++;
        this.targets.set(id, target.targetId);
      }
      return {
        tabId: id,
        url: target.url,
        title: target.title,
        active: id === this.selected,
        pinned: false,
      };
    });
  }

  private async createTab(
    transport: CdpWsTransport,
    signal: AbortSignal,
  ): Promise<{ tabId: number }> {
    const { targetId } = await transport.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
      { signal },
    );
    const tabId = this.nextTab++;
    this.targets.set(tabId, targetId);
    this.selected = tabId;
    this.invalidateSnapshot();
    return { tabId };
  }

  private async session(
    transport: CdpWsTransport,
    signal: AbortSignal,
  ): Promise<string> {
    const tabs = await this.listTabs(transport, signal);
    if (this.selected !== undefined && !this.targets.has(this.selected)) {
      this.selected = undefined;
      this.invalidateSnapshot();
      throw new Error(
        "Desktop browser tab closed. Take a fresh snapshot before continuing.",
      );
    }
    if (this.selected === undefined) {
      this.selected = tabs.find((tab) => /^https?:/.test(tab.url ?? ""))?.tabId;
      if (this.selected === undefined) {
        await this.createTab(transport, signal);
      }
    }
    const targetId = this.targets.get(this.selected!)!;
    let sessionId = this.sessions.get(targetId);
    if (!sessionId) {
      const attached = await transport.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
        { signal },
      );
      sessionId = attached.sessionId;
      this.sessions.set(targetId, sessionId);
      await transport.send("Page.enable", {}, { sessionId, signal });
      await transport.send("DOM.enable", {}, { sessionId, signal });
    }
    await transport.send("Target.activateTarget", { targetId }, { signal });
    return sessionId;
  }

  private async send<T>(
    transport: CdpWsTransport,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    generation: number,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.transport !== transport) {
      throw new Error("Desktop browser session expired");
    }
    if (method === "Vellum.createTab") {
      return (await this.createTab(transport, signal)) as T;
    }
    const targetId =
      this.selected === undefined ? undefined : this.targets.get(this.selected);
    const sessionId =
      (targetId && this.sessions.get(targetId)) ||
      (await this.session(transport, signal));
    if (
      method === "Input.dispatchMouseEvent" &&
      typeof params.x === "number" &&
      typeof params.y === "number"
    ) {
      await transport
        .send(
          "Runtime.evaluate",
          {
            expression: desktopCursorExpression(params.x, params.y),
            awaitPromise: true,
          },
          { sessionId, signal },
        )
        .catch(() => {});
      signal.throwIfAborted();
    }
    if (method.startsWith("Input.") && generation !== this.generation) {
      throw new Error(
        "The page changed before input. Take a fresh snapshot before continuing.",
      );
    }
    const key = JSON.stringify([
      sessionId,
      method,
      params.code ?? params.key ?? params.button,
    ]);
    const pressed =
      params.type === "keyDown" ||
      params.type === "rawKeyDown" ||
      params.type === "mousePressed";
    const previous = this.held.get(key);
    const heldInput = {
      targetId: this.targets.get(this.selected!)!,
      method,
      params: {
        ...params,
        type: method === "Input.dispatchKeyEvent" ? "keyUp" : "mouseReleased",
      },
    };
    if (pressed) {
      this.held.set(key, heldInput);
    }
    try {
      const result = await transport.send<T>(method, params, {
        sessionId,
        signal,
      });
      if (params.type === "keyUp" || params.type === "mouseReleased") {
        this.held.delete(key);
      }
      return result;
    } catch (error) {
      if (
        pressed &&
        error instanceof CdpWsTransportError &&
        error.code === "cdp_error" &&
        this.held.get(key) === heldInput
      ) {
        if (previous) {
          this.held.set(key, previous);
        } else {
          this.held.delete(key);
        }
      }
      throw new CdpError(
        error instanceof CdpWsTransportError && error.code === "aborted"
          ? "aborted"
          : "cdp_error",
        "Desktop browser command failed. A dispatched action may have completed; do not retry it automatically.",
        { underlying: error, cdpMethod: method },
      );
    }
  }

  async release(): Promise<void> {
    if (!this.transport) {
      return;
    }
    const signal = AbortSignal.timeout(3000);
    const cleanup = await this.connect(signal);
    try {
      const { targetInfos } = await cleanup.send<{ targetInfos: Target[] }>(
        "Target.getTargets",
        {},
        { signal },
      );
      const targets = new Set([
        ...this.sessions.keys(),
        ...[...this.held.values()].map((input) => input.targetId),
      ]);
      for (const targetId of targets) {
        if (!targetInfos.some((target) => target.targetId === targetId)) {
          for (const [key, input] of this.held) {
            if (input.targetId === targetId) {
              this.held.delete(key);
            }
          }
          continue;
        }
        const { sessionId } = await cleanup.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId, flatten: true },
          { signal },
        );
        for (const [key, input] of this.held) {
          if (input.targetId !== targetId) {
            continue;
          }
          await cleanup.send(input.method, input.params, { sessionId, signal });
          this.held.delete(key);
        }
        await cleanup.send(
          "Runtime.evaluate",
          { expression: REMOVE_DESKTOP_CURSOR },
          { sessionId, signal },
        );
      }
    } finally {
      cleanup.dispose();
    }
    this.dispose();
  }

  dispose(): void {
    this.invalidateSnapshot();
    this.transport?.dispose();
    this.transport = undefined;
    this.sessions.clear();
    this.targets.clear();
    this.selected = undefined;
    this.held.clear();
    this.conversation = undefined;
  }
}

import { z } from "zod";

import { transformAxTree } from "../tools/browser/cdp-client/accessibility-snapshot.js";
import {
  dispatchClickAt,
  dispatchInsertText,
  dispatchKeyPress,
  focusElement,
  scrollIntoViewIfNeeded,
} from "../tools/browser/cdp-client/cdp-dom-helpers.js";
import type { CdpClient, TabInfo } from "../tools/browser/cdp-client/types.js";
import {
  type DesktopBrowserBridge,
  desktopBrowserBridge,
} from "./desktop-browser-bridge.js";

export const desktopBrowserActionSchema = z
  .object({
    scope: z.literal("browser"),
    action: z.enum([
      "observe",
      "navigate",
      "select_tab",
      "new_tab",
      "close_tab",
      "click",
      "type",
      "key",
      "scroll",
      "wait",
    ]),
    observation_id: z.string().uuid().optional(),
    tab_id: z.number().int().positive().optional(),
    frame_id: z.string().max(256).optional(),
    element: z.string().max(20).optional(),
    url: z.string().url().max(8192).optional(),
    text: z.string().max(10000).optional(),
    key: z
      .enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ])
      .optional(),
    direction: z.enum(["up", "down"]).optional(),
    wait_ms: z.number().int().min(0).max(2000).optional(),
  })
  .strict();

type FrameTree = {
  frame: { id: string; loaderId: string; url: string; name?: string };
  childFrames?: FrameTree[];
};
type Observation = {
  id: string;
  tab: number;
  frame: string;
  loader: string;
  generation: number;
  nodes: Map<string, number>;
};

function frames(tree: FrameTree): FrameTree["frame"][] {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(frames)].slice(
    0,
    100,
  );
}

export class DesktopBrowser {
  private observation?: Observation;
  private tab?: number;
  private inputOwner?: { actor: string; conversation: string };
  constructor(
    private readonly bridge: DesktopBrowserBridge = desktopBrowserBridge,
  ) {}

  invalidate(): void {
    this.observation = undefined;
    this.tab = undefined;
  }

  async release(): Promise<void> {
    if (!this.inputOwner) {
      return;
    }
    const { actor, conversation } = this.inputOwner;
    this.invalidate();
    await this.bridge.send(
      "Vellum.releaseInput",
      {},
      undefined,
      actor,
      conversation,
      AbortSignal.timeout(3000),
    );
    this.inputOwner = undefined;
  }

  async execute(
    input: Record<string, unknown>,
    actor: string,
    conversation: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const action = desktopBrowserActionSchema.parse(input);
    const client: CdpClient = {
      send: (method, params, childSignal) =>
        this.bridge.send(
          method,
          params,
          this.tab?.toString(),
          actor,
          conversation,
          childSignal ?? signal,
        ),
      dispose: () => {},
    };
    const send = <T>(method: string, params?: Record<string, unknown>) =>
      client.send<T>(method, params, signal);
    if (action.action !== "observe") {
      const previous = this.observation;
      this.observation = undefined;
      if (
        !previous ||
        previous.id !== action.observation_id ||
        previous.generation !== this.bridge.generation ||
        previous.tab !== this.tab
      ) {
        throw new Error(
          "Stale browser observation. Observe again before acting.",
        );
      }
      const before = await send<{ frameTree: FrameTree }>("Page.getFrameTree");
      const frame = frames(before.frameTree).find(
        (frame) => frame.id === previous.frame,
      );
      if (
        !frame ||
        frame.loaderId !== previous.loader ||
        previous.generation !== this.bridge.generation
      ) {
        throw new Error(
          "Browser document changed. Observe again before acting.",
        );
      }
      if (action.action === "navigate") {
        const url = action.url ? new URL(action.url) : undefined;
        if (
          !url ||
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new Error(
            "Navigate requires an HTTP or HTTPS URL without credentials",
          );
        }
        const result = await send<{ errorText?: string }>("Page.navigate", {
          url: action.url,
        });
        if (result.errorText) {
          throw new Error(result.errorText);
        }
      } else if (action.action === "new_tab") {
        const result = await send<{ tabId: number }>("Vellum.createTab");
        this.tab = result.tabId;
      } else if (action.action === "select_tab") {
        if (!action.tab_id) {
          throw new Error("select_tab requires tab_id");
        }
        await send("Vellum.selectTab", { tabId: action.tab_id });
        this.tab = action.tab_id;
      } else if (action.action === "close_tab") {
        await send("Vellum.closeTab", { tabId: this.tab });
        this.tab = undefined;
      } else if (action.action === "wait") {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(done, action.wait_ms ?? 500);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Desktop browser wait interrupted"));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      } else {
        if (previous.frame !== before.frameTree.frame.id) {
          throw new Error(
            "Use a desktop screenshot for input in embedded frames. Browser frame observations support reading only.",
          );
        }
        this.inputOwner = { actor, conversation };
        if (action.action === "key") {
          if (!action.key) {
            throw new Error("key requires a key name");
          }
          await dispatchKeyPress(client, action.key, signal);
        } else if (action.action === "scroll") {
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: 300,
            y: 300,
            deltaX: 0,
            deltaY: action.direction === "up" ? -500 : 500,
          });
        } else {
          const node = action.element
            ? previous.nodes.get(action.element)
            : undefined;
          if (!node) {
            throw new Error(
              "Use an element from the latest browser observation",
            );
          }
          await scrollIntoViewIfNeeded(client, node, signal);
          const resolved = await send<{ object: { objectId?: string } }>(
            "DOM.resolveNode",
            { backendNodeId: node },
          );
          const objectId = resolved.object.objectId;
          if (!objectId) {
            throw new Error("Browser element is detached");
          }
          try {
            const checked = await send<{
              result: { value?: { x: number; y: number } };
              exceptionDetails?: unknown;
            }>("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: ACTIONABILITY,
              awaitPromise: true,
              returnByValue: true,
              arguments: [{ value: action.action === "type" }],
            });
            const point = checked.result.value;
            if (
              !point ||
              checked.exceptionDetails ||
              previous.generation !== this.bridge.generation
            ) {
              throw new Error(
                "Browser element is disabled, obscured, moving, or detached. Observe again.",
              );
            }
            signal.throwIfAborted();
            if (action.action === "click") {
              await dispatchClickAt(client, point, signal);
            } else {
              if (action.text === undefined) {
                throw new Error("type requires text");
              }
              await focusElement(client, node, signal);
              await dispatchInsertText(client, action.text, signal);
            }
          } finally {
            if (!signal.aborted) {
              await send("Runtime.releaseObject", { objectId }).catch(() => {});
            }
          }
        }
      }
    }
    return this.observe(
      client,
      action.action === "observe" ? action.tab_id : undefined,
      action.frame_id,
      signal,
    );
  }

  private async observe(
    client: CdpClient,
    requestedTab: number | undefined,
    requestedFrame: string | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.observation = undefined;
    const { tabs } = await client.send<{ tabs: TabInfo[] }>(
      "Vellum.listTabs",
      {},
      signal,
    );
    const boundedTabs = tabs.slice(0, 100);
    const selected = requestedTab ?? this.tab;
    const tab =
      boundedTabs.find((tab) => tab.tabId === selected) ??
      (requestedTab === undefined
        ? (boundedTabs.find(
            (tab) => tab.active && /^https?:/.test(tab.url ?? ""),
          ) ?? boundedTabs.find((tab) => /^https?:/.test(tab.url ?? "")))
        : undefined);
    if (!tab?.tabId) {
      if (requestedTab !== undefined) {
        throw new Error("Requested desktop browser tab is unavailable");
      }
      const created = await client.send<{ tabId: number }>(
        "Vellum.createTab",
        {},
        signal,
      );
      this.tab = created.tabId;
    } else {
      this.tab = tab.tabId;
    }
    await client.send("Vellum.selectTab", { tabId: this.tab }, signal);
    await client.send("Page.enable", {}, signal);
    await client.send("DOM.enable", {}, signal);
    const { frameTree } = await client.send<{ frameTree: FrameTree }>(
      "Page.getFrameTree",
      {},
      signal,
    );
    const availableFrames = frames(frameTree);
    const frame = requestedFrame
      ? availableFrames.find((frame) => frame.id === requestedFrame)
      : frameTree.frame;
    if (!frame) {
      throw new Error("Browser frame is unavailable");
    }
    const generation = this.bridge.generation;
    const tree = await client.send<{
      nodes: {
        role?: { value?: string };
        name?: { value?: string };
        ignored?: boolean;
      }[];
    }>("Accessibility.getFullAXTree", { frameId: frame.id }, signal);
    const snapshot = transformAxTree(tree, { maxElements: 100 });
    const after = await client.send<{ frameTree: FrameTree }>(
      "Page.getFrameTree",
      {},
      signal,
    );
    if (
      generation !== this.bridge.generation ||
      frames(after.frameTree).find((current) => current.id === frame.id)
        ?.loaderId !== frame.loaderId
    ) {
      throw new Error("Browser navigated during observation. Observe again.");
    }
    const id = crypto.randomUUID();
    this.observation = {
      id,
      tab: this.tab!,
      frame: frame.id,
      loader: frame.loaderId,
      generation,
      nodes: snapshot.selectorMap,
    };
    return {
      observation_id: id,
      tab_id: this.tab,
      frame_id: frame.id,
      url: frame.url.slice(0, 2048),
      tabs: boundedTabs.map(({ tabId, title, url, active }) => ({
        tab_id: tabId,
        title: title?.slice(0, 160),
        url: url?.slice(0, 2048),
        active,
      })),
      frames: availableFrames.map((item) => ({
        frame_id: item.id,
        url: item.url.slice(0, 2048),
        input: item.id === frameTree.frame.id,
      })),
      text: tree.nodes
        .filter(
          (node) =>
            !node.ignored &&
            ["StaticText", "heading"].includes(node.role?.value ?? ""),
        )
        .map((node) => node.name?.value ?? "")
        .join("\n")
        .slice(0, 12000),
      elements: snapshot.elements.map(
        ({ backendNodeId: _node, value: _value, ...element }) => element,
      ),
    };
  }
}

const ACTIONABILITY = `async function(editable) {
  const rect = () => { const r = this.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
  const before = rect();
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = rect();
  if (!this.isConnected || this.matches(':disabled') || this.closest('[inert],[aria-disabled="true"]')) { return null; }
  if (editable && (this.readOnly || !(this.isContentEditable || this.matches('textarea') || (this.matches('input') && ['text','search','email','tel','url','number'].includes(this.type))))) { return null; }
  const style = getComputedStyle(this);
  if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0 || after.w <= 0 || after.h <= 0) { return null; }
  if (Object.keys(before).some(key => Math.abs(before[key] - after[key]) > 1)) { return null; }
  const x = Math.max(0, after.x) + (Math.min(innerWidth, after.x + after.w) - Math.max(0, after.x)) / 2;
  const y = Math.max(0, after.y) + (Math.min(innerHeight, after.y + after.h) - Math.max(0, after.y)) / 2;
  const hit = this.getRootNode().elementFromPoint?.(x,y) || document.elementFromPoint(x,y);
  if (!hit || !(hit === this || this.contains(hit))) { return null; }
  return {x,y};
}`;

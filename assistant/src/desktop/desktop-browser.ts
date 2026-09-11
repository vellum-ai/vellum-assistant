import { z } from "zod";

import { transformAxTree } from "../tools/browser/cdp-client/accessibility-snapshot.js";
import { actionableElement } from "../tools/browser/cdp-client/cdp-actionability.js";
import {
  dispatchClickAt,
  dispatchInsertText,
  dispatchKeyPress,
  dispatchKeyRelease,
  evaluateExpression,
  focusElement,
  scrollIntoViewIfNeeded,
  waitForText,
} from "../tools/browser/cdp-client/cdp-dom-helpers.js";
import {
  type CdpWsTransport,
  connectCdpWsTransport,
} from "../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import type { CdpClient } from "../tools/browser/cdp-client/types.js";

const observed = { observation_id: z.string().uuid() };
const ref = { ...observed, ref: z.string().regex(/^e\d+$/) };
export const desktopBrowserActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("observe"),
    target_id: z.string().max(200).optional(),
    frame_id: z.string().max(200).optional(),
  }),
  z.object({ action: z.literal("tabs") }),
  z.object({ action: z.literal("new_tab"), ...observed }),
  z.object({ action: z.literal("close_tab"), ...observed }),
  z.object({
    action: z.literal("navigate"),
    ...observed,
    url: z
      .string()
      .url()
      .max(8_000)
      .refine(
        (value) => ["https:", "http:"].includes(new URL(value).protocol),
        "Use an HTTP or HTTPS URL",
      ),
  }),
  z.object({ action: z.literal("click"), ...ref }),
  z.object({
    action: z.literal("type"),
    ...ref,
    text: z.string().min(1).max(10_000),
  }),
  z.object({
    action: z.literal("key"),
    ...ref,
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
  z.object({
    action: z.literal("scroll"),
    ...observed,
    direction: z.enum(["up", "down"]),
    amount: z.number().int().min(1).max(5).default(1),
  }),
  z.object({
    action: z.literal("wait"),
    ...observed,
    text: z.string().min(1).max(500),
    timeout_ms: z.number().int().min(100).max(10_000).default(5_000),
  }),
]);
export type DesktopBrowserAction = z.infer<typeof desktopBrowserActionSchema>;
type Target = { targetId: string; type: string; title: string; url: string };
type Frame = { id: string; loaderId: string; url: string; parentId?: string };
type FrameTree = { frame: Frame; childFrames?: FrameTree[] };
type Observation = {
  id: string;
  target: string;
  frame: string;
  document: number;
  epoch: number;
  context: number;
  refs: Map<string, number>;
};

export class DesktopBrowser {
  private transport?: CdpWsTransport;
  private target?: string;
  private session?: string;
  private frame?: string;
  private observation?: Observation;
  private epoch = 0;
  private removeEvents?: () => void;
  private mouse?: { x: number; y: number };
  private key?: string;

  constructor(
    private readonly connect: (signal: AbortSignal) => Promise<CdpWsTransport>,
  ) {}

  invalidate(): void {
    this.epoch += 1;
    this.observation = undefined;
  }

  dispose(): void {
    this.invalidate();
    this.removeEvents?.();
    this.removeEvents = undefined;
    this.transport?.dispose();
    this.transport = undefined;
    this.target = this.session = this.frame = undefined;
  }

  async release(): Promise<void> {
    try {
      if (this.transport && this.session) {
        const opts = {
          sessionId: this.session,
          signal: AbortSignal.timeout(1_000),
        };
        if (this.mouse) {
          await this.transport.send(
            "Input.dispatchMouseEvent",
            {
              ...this.mouse,
              type: "mouseReleased",
              button: "left",
              clickCount: 1,
            },
            opts,
          );
        }
        if (this.key) {
          await dispatchKeyRelease(
            this.client(this.transport, opts.signal),
            this.key,
            opts.signal,
          );
        }
      }
    } finally {
      this.mouse = undefined;
      this.key = undefined;
      this.dispose();
    }
  }

  private async browser(signal: AbortSignal): Promise<CdpWsTransport> {
    if (!this.transport) {
      const transport = await this.connect(signal);
      if (signal.aborted) {
        transport.dispose();
        signal.throwIfAborted();
      }
      this.transport = transport;
      this.removeEvents = transport.addEventListener((event) => {
        if (
          event.sessionId === this.session &&
          [
            "Page.frameNavigated",
            "Page.frameDetached",
            "Page.navigatedWithinDocument",
            "DOM.documentUpdated",
            "Runtime.executionContextsCleared",
          ].includes(event.method)
        ) {
          this.invalidate();
        }
        if (
          event.method === "Target.detachedFromTarget" &&
          (event.params as { sessionId?: string })?.sessionId === this.session
        ) {
          this.invalidate();
          this.session = this.target = this.frame = undefined;
        }
      });
    }
    return this.transport;
  }

  private client(
    transport: CdpWsTransport,
    signal: AbortSignal,
    context?: number,
  ): CdpClient {
    const sessionId = this.session;
    return {
      send: (method, params, callerSignal) => {
        signal.throwIfAborted();
        if (!sessionId || sessionId !== this.session) {
          throw new Error("Desktop tab session changed. Observe again.");
        }
        return transport.send(
          method,
          {
            ...params,
            ...(method === "Runtime.evaluate" && context
              ? { contextId: context }
              : {}),
          },
          {
            sessionId,
            signal: callerSignal
              ? AbortSignal.any([signal, callerSignal])
              : signal,
          },
        );
      },
      dispose: () => {},
    };
  }

  private async targets(
    transport: CdpWsTransport,
    signal: AbortSignal,
  ): Promise<Target[]> {
    const { targetInfos } = await transport.send<{ targetInfos: Target[] }>(
      "Target.getTargets",
      {},
      { signal },
    );
    return targetInfos.filter((target) => target.type === "page").slice(0, 50);
  }

  private async select(
    transport: CdpWsTransport,
    target: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (target !== this.target || !this.session) {
      this.invalidate();
      if (this.session) {
        await transport.send(
          "Target.detachFromTarget",
          { sessionId: this.session },
          { signal },
        );
      }
      this.session = this.target = this.frame = undefined;
      const attached = await transport.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: target, flatten: true },
        { signal },
      );
      this.session = attached.sessionId;
      this.target = target;
      const cdp = this.client(transport, signal);
      await cdp.send("Page.enable");
      await cdp.send("DOM.enable");
      await cdp.send("Runtime.enable");
    }
    await transport.send(
      "Target.activateTarget",
      { targetId: target },
      { signal },
    );
    await this.client(transport, signal).send("Page.bringToFront");
  }

  private async document(cdp: CdpClient, context: number): Promise<number> {
    const result = await cdp.send<{ result: { objectId: string } }>(
      "Runtime.evaluate",
      {
        expression: "document",
        contextId: context,
        objectGroup: "desktop-observation",
      },
    );
    const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
      "DOM.describeNode",
      { objectId: result.result.objectId },
    );
    return node.backendNodeId;
  }

  private async observe(
    transport: CdpWsTransport,
    signal: AbortSignal,
    frameId?: string,
  ): Promise<Record<string, unknown>> {
    this.invalidate();
    const cdp = this.client(transport, signal);
    await cdp.send("Runtime.releaseObjectGroup", {
      objectGroup: "desktop-observation",
    });
    const { frameTree } = await cdp.send<{ frameTree: FrameTree }>(
      "Page.getFrameTree",
    );
    const frames: Frame[] = [];
    const visit = (tree: FrameTree) => {
      frames.push(tree.frame);
      for (const child of tree.childFrames ?? []) {
        visit(child);
      }
    };
    visit(frameTree);
    const frame = frames.find(
      (entry) => entry.id === (frameId ?? this.frame ?? frameTree.frame.id),
    );
    if (!frame) {
      throw new Error(
        "Frame disappeared. Observe the tab again with its current frame ID.",
      );
    }
    this.frame = frame.id;
    const epoch = this.epoch;
    const { executionContextId } = await cdp.send<{
      executionContextId: number;
    }>("Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "vellum-desktop",
    });
    const scoped = this.client(transport, signal, executionContextId);
    const document = await this.document(scoped, executionContextId);
    const ax = transformAxTree(
      await scoped.send("Accessibility.getFullAXTree", { frameId: frame.id }),
      { maxElements: 150 },
    );
    const page = await evaluateExpression<{
      url: string;
      title: string;
      text: string;
      ready: string;
      visible: boolean;
    }>(
      scoped,
      "({url: location.href.slice(0, 4000), title: document.title.slice(0, 500), text: (document.body?.innerText ?? '').slice(0, 12000), ready: document.readyState, visible: document.visibilityState === 'visible'})",
      {},
      signal,
    );
    if (
      !page.visible ||
      epoch !== this.epoch ||
      document !== (await this.document(scoped, executionContextId))
    ) {
      throw new Error("Page changed or is not foreground. Observe again.");
    }
    const id = crypto.randomUUID();
    this.observation = {
      id,
      epoch,
      target: this.target!,
      frame: frame.id,
      document,
      context: executionContextId,
      refs: ax.selectorMap,
    };
    return {
      scope: "browser",
      observation_id: id,
      target_id: this.target,
      frame_id: frame.id,
      ...page,
      frames: frames
        .slice(0, 30)
        .map(({ id, url }) => ({ frame_id: id, url: url.slice(0, 2000) })),
      elements: ax.elements.map(
        ({ backendNodeId: _node, value: _value, ...element }) => element,
      ),
      limits:
        "Up to 150 controls, 12000 characters of page text and 30 frames. Use desktop scope for browser chrome, canvas, or inaccessible frames.",
    };
  }

  async execute(
    action: DesktopBrowserAction,
    callerSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(15_000)]);
    let dispatched = false;
    try {
      const transport = await this.browser(signal);
      const targets = await this.targets(transport, signal);
      if (action.action === "tabs") {
        this.invalidate();
        return {
          scope: "browser",
          observation_id: crypto.randomUUID(),
          tabs: targets.map(({ targetId, title, url }) => ({
            target_id: targetId,
            title: title.slice(0, 500),
            url: url.slice(0, 4000),
            selected: targetId === this.target,
          })),
          next: "Observe a target_id before acting.",
        };
      }
      if (action.action === "observe") {
        const target =
          action.target_id ??
          this.target ??
          (targets.length === 1 ? targets[0]!.targetId : undefined);
        if (!target || !targets.some((entry) => entry.targetId === target)) {
          throw new Error(
            "Select a current target_id from browser tabs, then observe it.",
          );
        }
        await this.select(transport, target, signal);
        return await this.observe(transport, signal, action.frame_id);
      }
      const observation = this.observation;
      if (
        !observation ||
        observation.id !== action.observation_id ||
        observation.epoch !== this.epoch ||
        observation.target !== this.target ||
        observation.frame !== this.frame ||
        !targets.some((entry) => entry.targetId === this.target)
      ) {
        throw new Error(
          "Stale browser observation. Observe again before acting.",
        );
      }
      this.observation = undefined;
      const cdp = this.client(transport, signal, observation.context);
      if (
        (await this.document(cdp, observation.context)) !==
          observation.document ||
        observation.epoch !== this.epoch ||
        !(await evaluateExpression<boolean>(
          cdp,
          "document.visibilityState === 'visible'",
          {},
          signal,
        ))
      ) {
        throw new Error(
          "Browser document changed or is not foreground. Observe again.",
        );
      }
      if (action.action === "wait") {
        await waitForText(cdp, action.text, action.timeout_ms, signal);
      } else if (action.action === "navigate") {
        if (
          this.frame !==
          (await cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree"))
            .frameTree.frame.id
        ) {
          throw new Error("Observe the main frame before navigating the tab.");
        }
        dispatched = true;
        const result = await cdp.send<{
          errorText?: string;
          loaderId?: string;
          frameId: string;
        }>("Page.navigate", {
          url: action.url,
        });
        if (result.errorText) {
          throw new Error(result.errorText);
        }
        this.frame = undefined;
        if (result.loaderId) {
          while (true) {
            signal.throwIfAborted();
            const current = await this.client(transport, signal).send<{
              frameTree: FrameTree;
            }>("Page.getFrameTree");
            if (current.frameTree.frame.loaderId === result.loaderId) {
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
      } else if (action.action === "new_tab") {
        dispatched = true;
        const { targetId } = await transport.send<{ targetId: string }>(
          "Target.createTarget",
          { url: "about:blank" },
          { signal },
        );
        await this.select(transport, targetId, signal);
      } else if (action.action === "close_tab") {
        dispatched = true;
        await transport.send(
          "Target.closeTarget",
          { targetId: this.target },
          { signal },
        );
        this.invalidate();
        this.target = this.session = this.frame = undefined;
        return {
          scope: "browser",
          outcome: "dispatched",
          observation_id: crypto.randomUUID(),
          next: "List tabs and observe a target before continuing.",
        };
      } else if (action.action === "scroll") {
        dispatched = true;
        await evaluateExpression(
          cdp,
          `window.scrollBy(0, ${action.amount * (action.direction === "down" ? 600 : -600)})`,
          {},
          signal,
        );
      } else {
        const backendNodeId = observation.refs.get(action.ref);
        if (!backendNodeId) {
          throw new Error("Unknown element reference. Observe again.");
        }
        const resolved = await cdp.send<{ object: { objectId: string } }>(
          "DOM.resolveNode",
          {
            backendNodeId,
            executionContextId: observation.context,
            objectGroup: "desktop-observation",
          },
        );
        // Scrolling/focus can trigger page handlers, so subsequent errors are uncertain.
        dispatched = true;
        await scrollIntoViewIfNeeded(cdp, backendNodeId, signal);
        const point = await actionableElement(
          cdp,
          resolved.object.objectId,
          action.action === "type",
          signal,
        );
        if (observation.epoch !== this.epoch) {
          throw new Error("Document changed during actionability check");
        }
        if (action.action === "click") {
          if (
            this.frame !==
            (await cdp.send<{ frameTree: FrameTree }>("Page.getFrameTree"))
              .frameTree.frame.id
          ) {
            throw new Error(
              "Use desktop scope for frame clicks; frame coordinates are not desktop coordinates.",
            );
          }
          this.mouse = point;
          await dispatchClickAt(cdp, point, signal);
          this.mouse = undefined;
        } else {
          await focusElement(cdp, backendNodeId, signal);
          const focus = await cdp.send<{ result: { value: boolean } }>(
            "Runtime.callFunctionOn",
            {
              objectId: resolved.object.objectId,
              functionDeclaration:
                "function() { return this.isConnected && this.getRootNode().activeElement === this; }",
              returnByValue: true,
            },
          );
          if (!focus.result.value || observation.epoch !== this.epoch) {
            throw new Error("Element lost focus. Observe again.");
          }
          if (action.action === "type") {
            await dispatchInsertText(cdp, action.text, signal);
          } else {
            this.key = action.key;
            await dispatchKeyPress(cdp, action.key, signal);
            this.key = undefined;
          }
        }
      }
      return {
        ...(await this.observe(transport, signal)),
        outcome: dispatched ? "dispatched" : "observed",
      };
    } catch (error) {
      this.invalidate();
      return {
        scope: "browser",
        error: error instanceof Error ? error.message : String(error),
        outcome: dispatched ? "unknown" : "not_dispatched",
        next: dispatched
          ? "An action may have reached Chrome. Observe the current state before deciding whether further action is needed. Do not blindly retry."
          : "Observe again, or use desktop scope for a screenshot and X11 input.",
      };
    }
  }
}

export function connectDesktopBrowser(
  url: string,
  signal: AbortSignal,
): Promise<CdpWsTransport> {
  return connectCdpWsTransport(url, { signal, connectTimeoutMs: 3_000 });
}

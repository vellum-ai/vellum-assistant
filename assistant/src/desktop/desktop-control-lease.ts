import { getConfig } from "../config/loader.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { desktopDependencyInstaller } from "./desktop-dependencies.js";
import { isAssistantDesktopEnabled } from "./desktop-feature.js";
import {
  type DesktopSessionManager,
  type DesktopViewer,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";
import { DesktopViewerInput } from "./desktop-viewer-input.js";

const log = getLogger("desktop-control");
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIONS = 100;
export type DesktopControlLeaseStatus = {
  state: "idle" | "assistant" | "human";
};
type Owner = {
  conversationId: string;
  actorId: string;
  abort: AbortController;
  holder: DesktopViewer;
  removeAbortListener: () => void;
  id: string;
  sequence: number;
  cleanups: Set<() => Promise<void>>;
  actions: number;
  lastActivity: number;
  desktopLost: boolean;
};

export class DesktopControlLease {
  private owner: Owner | null = null;
  private humanControl = false;
  private inputCleanupPending = false;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      enabled: () => boolean;
      ready: () => boolean;
      manager: () => DesktopSessionManager;
      input: Pick<DesktopViewerInput, "setViewerInput">;
      notify: () => Promise<unknown>;
    } = {
      enabled: () => isAssistantDesktopEnabled(getConfig()),
      ready: () => desktopDependencyInstaller.getStatus().state === "ready",
      manager: getDesktopSessionManager,
      input: new DesktopViewerInput(),
      notify: () => publishSyncInvalidation([SYNC_TAGS.assistantDesktop]),
    },
  ) {}

  getStatus(): DesktopControlLeaseStatus {
    return {
      state:
        this.owner || this.inputCleanupPending
          ? "assistant"
          : this.humanControl
            ? "human"
            : "idle",
    };
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

  private notify(): void {
    void this.deps
      .notify()
      .catch((err) => log.warn({ err }, "Desktop control notification failed"));
  }

  private assertAvailable(): void {
    if (!this.deps.enabled()) {
      throw new Error("Desktop control is not available on this assistant");
    }
    if (!this.deps.ready()) {
      throw new Error(
        "Open the Desktop modal and wait for automatic installation to finish before using desktop control",
      );
    }
  }

  async takeControl(): Promise<DesktopControlLeaseStatus> {
    this.humanControl = true;
    this.generation += 1;
    this.owner?.abort.abort();
    return this.exclusive(async () => {
      await this.release();
      this.notify();
      return this.getStatus();
    });
  }

  allowAssistant(): Promise<DesktopControlLeaseStatus> {
    return this.exclusive(async () => {
      this.assertAvailable();
      this.humanControl = false;
      this.generation += 1;
      this.notify();
      return this.getStatus();
    });
  }

  private async releaseInput(): Promise<void> {
    try {
      await this.deps.manager().browser?.release();
    } finally {
      await Promise.all(
        [...(this.owner?.cleanups ?? [])].map((cleanup) => cleanup()),
      );
    }
  }

  private async release(): Promise<void> {
    const owner = this.owner;
    if (!owner && !this.inputCleanupPending) {
      return;
    }
    owner?.abort.abort();
    owner?.removeAbortListener();
    this.inputCleanupPending = true;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    try {
      if (!owner?.desktopLost) {
        try {
          await this.releaseInput();
        } finally {
          await this.deps.input.setViewerInput(true);
        }
      }
      this.inputCleanupPending = false;
    } finally {
      if (!this.inputCleanupPending) {
        if (owner) {
          this.deps.manager().releaseAutomationSlot(owner.holder);
        }
        this.owner = null;
      }
      this.notify();
    }
  }

  private cancel(owner: Owner): void {
    if (this.owner !== owner) {
      return;
    }
    this.generation += 1;
    owner.abort.abort();
    void this.exclusive(() => this.release()).catch((err) =>
      log.warn({ err }, "Desktop control cleanup failed"),
    );
  }

  private bindCancellation(owner: Owner, signal?: AbortSignal): void {
    owner.removeAbortListener();
    const cancel = () => this.cancel(owner);
    signal?.addEventListener("abort", cancel, { once: true });
    owner.removeAbortListener = () =>
      signal?.removeEventListener("abort", cancel);
    if (signal?.aborted) {
      cancel();
    }
  }

  private async claim(context: ToolContext): Promise<Owner> {
    const holder: DesktopViewer = {
      onDesktopLost: () => {
        owner.desktopLost = true;
        this.cancel(owner);
      },
    };
    const owner: Owner = {
      conversationId: context.conversationId,
      actorId: context.sourceActorPrincipalId!,
      abort: new AbortController(),
      holder,
      actions: 0,
      lastActivity: Date.now(),
      desktopLost: false,
      id: crypto.randomUUID(),
      sequence: 0,
      cleanups: new Set(),
      removeAbortListener: () => {},
    };
    const slot = this.deps.manager().acquireAutomationSlot(holder);
    if (!slot.ok) {
      throw new Error("The desktop is busy or shutting down");
    }
    this.owner = owner;
    this.bindCancellation(owner, context.signal);
    const cancel = () => this.cancel(owner);
    this.watchdog = setInterval(() => {
      try {
        if (
          Date.now() - owner.lastActivity > IDLE_TIMEOUT_MS ||
          !this.deps.enabled() ||
          !this.deps.ready()
        ) {
          cancel();
        }
      } catch (err) {
        log.warn({ err }, "Desktop control availability check failed");
        cancel();
      }
    }, 1_000);
    this.watchdog.unref?.();
    try {
      await this.deps.manager().ensureDesktopRunning();
      owner.abort.signal.throwIfAborted();
      this.assertAvailable();
      await this.deps.input.setViewerInput(false);
      await this.releaseInput();
      this.inputCleanupPending = false;
      this.notify();
      return owner;
    } catch (err) {
      await this.release().catch((cleanupError) =>
        log.warn({ err: cleanupError }, "Desktop control cleanup failed"),
      );
      throw err;
    }
  }

  runBrowser(
    context: ToolContext,
    operation: (signal: AbortSignal) => Promise<ToolExecutionResult>,
    done = false,
  ): Promise<ToolExecutionResult> {
    return this.run(context, ({ signal }) => operation(signal), { done });
  }

  run(
    context: ToolContext,
    operation: (session: {
      signal: AbortSignal;
      leaseId: string;
      sequence: number;
      assertAvailable: () => void;
    }) => Promise<ToolExecutionResult>,
    options: {
      done?: boolean;
      requiresLease?: boolean;
      countAction?: boolean;
      cleanup?: () => Promise<void>;
    } = {},
  ): Promise<ToolExecutionResult> {
    const generation = this.generation;
    return this.exclusive(async () => {
      if (
        context.trustClass !== "guardian" ||
        !context.sourceActorPrincipalId ||
        !context.conversationId
      ) {
        throw new Error(
          "Desktop control requires an identified guardian conversation",
        );
      }
      if (
        this.owner &&
        (this.owner.conversationId !== context.conversationId ||
          this.owner.actorId !== context.sourceActorPrincipalId)
      ) {
        throw new Error("Another conversation is controlling the desktop");
      }
      if (options.done) {
        await this.release();
        return { content: "Desktop control released.", isError: false };
      }
      context.signal?.throwIfAborted();
      try {
        this.assertAvailable();
      } catch (error) {
        await this.release();
        throw error;
      }
      if (this.humanControl || generation !== this.generation) {
        return {
          content:
            "Desktop control was interrupted. The user can select Allow assistant in the desktop modal, then ask you to continue. Observe again before acting.",
          isError: true,
          yieldToUser: true,
        };
      }
      if (!this.owner && options.requiresLease) {
        throw new Error("Observe the desktop before acting");
      }
      if (this.owner) {
        this.bindCancellation(this.owner, context.signal);
      }
      const owner = this.owner ?? (await this.claim(context));
      const signal = context.signal
        ? AbortSignal.any([context.signal, owner.abort.signal])
        : owner.abort.signal;
      owner.lastActivity = Date.now();
      signal.throwIfAborted();
      try {
        this.assertAvailable();
        if (options.cleanup && !owner.cleanups.has(options.cleanup)) {
          owner.cleanups.add(options.cleanup);
          await options.cleanup();
          signal.throwIfAborted();
          this.assertAvailable();
        }
        if (options.countAction !== false && ++owner.actions > MAX_ACTIONS) {
          throw new Error(
            "Desktop action limit reached. Finish this session before continuing.",
          );
        }
        const result = await operation({
          signal,
          leaseId: owner.id,
          sequence: ++owner.sequence,
          assertAvailable: () => this.assertAvailable(),
        });
        signal.throwIfAborted();
        if (result.isError) {
          await this.release();
        }
        return result;
      } catch (err) {
        await this.release().catch((cleanupError) =>
          log.warn({ err: cleanupError }, "Desktop control cleanup failed"),
        );
        throw err;
      }
    });
  }
}

export const desktopControlLease = new DesktopControlLease();

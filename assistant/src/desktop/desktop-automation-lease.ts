import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { desktopDependencyInstaller } from "./desktop-dependencies.js";
import {
  type DesktopSessionManager,
  type DesktopViewer,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";
import { isVirtualDesktopEnabled } from "./virtual-desktop-feature.js";

const log = getLogger("desktop-automation-lease");
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIONS = 100;
type Owner = {
  conversationId: string;
  actorId: string;
  abort: AbortController;
  holder: DesktopViewer;
  removeAbortListener: () => void;
  actions: number;
  lastActivity: number;
  desktopLost: boolean;
  humanHelp?: symbol;
};

export class DesktopAutomationLease {
  private owner: Owner | null = null;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      enabled: () => boolean;
      ready: () => boolean;
      ensureReady: (signal: AbortSignal) => Promise<void>;
      manager: () => DesktopSessionManager;
      notify: () => Promise<unknown>;
    } = {
      enabled: isVirtualDesktopEnabled,
      ready: () => desktopDependencyInstaller.getStatus().state === "ready",
      ensureReady: (signal) => desktopDependencyInstaller.ensureReady(signal),
      manager: getDesktopSessionManager,
      notify: async () =>
        broadcastMessage({ type: "desktop_activity_changed" }),
    },
  ) {}

  get isActive(): boolean {
    return (
      this.owner !== null &&
      !this.owner.humanHelp &&
      !this.owner.abort.signal.aborted
    );
  }

  private notify(): void {
    void this.deps
      .notify()
      .catch((err) =>
        log.warn({ err }, "Desktop browser activity notification failed"),
      );
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

  private assertAvailable(): void {
    if (!this.deps.enabled()) {
      throw new Error(
        "Virtual desktop browser automation is available only on enabled platform-hosted assistants",
      );
    }
    if (!this.deps.ready()) {
      throw new Error(
        "Open the Virtual desktop panel and wait for automatic installation to finish before using desktop browser automation",
      );
    }
  }

  private async release(): Promise<void> {
    const owner = this.owner;
    if (!owner) {
      return;
    }
    owner.abort.abort();
    owner.removeAbortListener();
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (!owner.desktopLost) {
      await this.deps.manager().browser.release();
    }
    this.deps.manager().releaseAutomationSlot(owner.holder);
    this.owner = null;
  }

  private cancel(owner: Owner): void {
    if (this.owner !== owner) {
      return;
    }
    this.generation += 1;
    owner.abort.abort();
    this.releaseCancelledOwner(owner);
  }

  private releaseCancelledOwner(owner: Owner): void {
    void this.exclusive(async () => {
      if (this.owner === owner) {
        await this.release();
      }
    }).catch((err) => {
      log.warn({ err }, "Desktop browser session cleanup failed");
      const retry = setTimeout(() => this.releaseCancelledOwner(owner), 1_000);
      retry.unref?.();
    });
  }

  releaseForConversation(conversationId: string): void {
    if (this.owner?.conversationId === conversationId) {
      this.cancel(this.owner);
    }
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
      removeAbortListener: () => {},
    };
    const slot = this.deps.manager().acquireAutomationSlot(holder);
    if (!slot.ok) {
      throw new Error("The desktop is busy or shutting down");
    }
    this.owner = owner;
    owner.abort.signal.addEventListener("abort", () => this.notify(), {
      once: true,
    });
    this.notify();
    this.bindCancellation(owner, context.signal);
    const cancel = () => this.cancel(owner);
    this.watchdog = setInterval(() => {
      try {
        if (
          (!owner.humanHelp &&
            Date.now() - owner.lastActivity > IDLE_TIMEOUT_MS) ||
          !this.deps.enabled() ||
          !this.deps.ready()
        ) {
          cancel();
        }
      } catch (err) {
        log.warn({ err }, "Desktop browser session availability check failed");
        cancel();
      }
    }, 1_000);
    this.watchdog.unref?.();
    try {
      await this.deps.manager().ensureDesktopRunning();
      owner.abort.signal.throwIfAborted();
      this.assertAvailable();
      await this.deps.manager().browser.release();
      return owner;
    } catch (err) {
      await this.release().catch((cleanupError) =>
        log.warn(
          { err: cleanupError },
          "Desktop browser session cleanup failed",
        ),
      );
      throw err;
    }
  }

  async reserveForHuman(
    context: ToolContext,
  ): Promise<(resume: boolean) => Promise<void>> {
    let reservedOwner: Owner | undefined;
    const reservation = Symbol("human-help");
    const result = await this.runBrowser(context, async () => {
      await this.deps.manager().browser.release();
      reservedOwner = this.owner!;
      reservedOwner.humanHelp = reservation;
      this.notify();
      return { content: "", isError: false };
    });
    if (result.isError || !reservedOwner) {
      throw new Error(
        "Desktop help was interrupted before control could be handed over.",
      );
    }
    const owner = reservedOwner;
    return (resume) =>
      this.exclusive(async () => {
        if (this.owner !== owner || owner.humanHelp !== reservation) {
          return;
        }
        if (resume && !owner.abort.signal.aborted) {
          owner.humanHelp = undefined;
          owner.lastActivity = Date.now();
          this.notify();
        } else {
          try {
            await this.release();
          } catch (error) {
            this.releaseCancelledOwner(owner);
            throw error;
          }
        }
      });
  }

  runBrowser(
    context: ToolContext,
    operation: (signal: AbortSignal) => Promise<ToolExecutionResult>,
    done = false,
  ): Promise<ToolExecutionResult> {
    const generation = this.generation;
    return this.exclusive(async () => {
      if (
        context.trustClass !== "guardian" ||
        !context.sourceActorPrincipalId ||
        !context.conversationId
      ) {
        throw new Error(
          "Desktop browser session requires an identified guardian conversation",
        );
      }
      if (
        this.owner &&
        (this.owner.conversationId !== context.conversationId ||
          this.owner.actorId !== context.sourceActorPrincipalId)
      ) {
        throw new Error("Another conversation is controlling the desktop");
      }
      if (this.owner?.humanHelp) {
        throw new Error(
          "The desktop is reserved while the user is helping. Wait for Done or Skip.",
        );
      }
      if (done) {
        await this.release();
        return { content: "Desktop browser session released.", isError: false };
      }
      context.signal?.throwIfAborted();
      try {
        if (
          !this.owner &&
          generation === this.generation &&
          this.deps.enabled() &&
          !this.deps.ready()
        ) {
          const abort = new AbortController();
          const signal = AbortSignal.any([
            abort.signal,
            ...(context.signal ? [context.signal] : []),
          ]);
          const timeout = setTimeout(
            () =>
              abort.abort(
                new Error(
                  "Virtual desktop setup is taking too long. Check installation progress in the Virtual desktop panel. No browser action was performed.",
                ),
              ),
            8 * 60_000,
          );
          const watchdog = setInterval(() => {
            if (!this.deps.enabled()) {
              abort.abort(
                new Error("Virtual desktop was disabled during setup"),
              );
            }
          }, 1_000);
          try {
            await this.deps.ensureReady(signal);
            signal.throwIfAborted();
          } finally {
            clearTimeout(timeout);
            clearInterval(watchdog);
          }
        }
        this.assertAvailable();
      } catch (error) {
        await this.release();
        throw error;
      }
      if (generation !== this.generation) {
        return {
          content:
            "Desktop browser session was interrupted. Take a fresh snapshot before continuing.",
          isError: true,
        };
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
        if (++owner.actions > MAX_ACTIONS) {
          throw new Error(
            "Desktop action limit reached. Finish this session before continuing.",
          );
        }
        const result = await operation(signal);
        signal.throwIfAborted();
        if (result.isError) {
          await this.release();
        }
        return result;
      } catch (err) {
        await this.release().catch((cleanupError) =>
          log.warn(
            { err: cleanupError },
            "Desktop browser session cleanup failed",
          ),
        );
        throw err;
      }
    });
  }
}

export const desktopAutomationLease = new DesktopAutomationLease();

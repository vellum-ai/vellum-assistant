import { getConfig } from "../config/loader.js";
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
  id: string;
  sequence: number;
  cleanups: Set<() => Promise<void>>;
  actions: number;
  lastActivity: number;
  desktopLost: boolean;
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
    } = {
      enabled: () => isVirtualDesktopEnabled(getConfig()),
      ready: () => desktopDependencyInstaller.getStatus().state === "ready",
      ensureReady: (signal) => desktopDependencyInstaller.ensureReady(signal),
      manager: getDesktopSessionManager,
    },
  ) {}

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
    if (!owner) {
      return;
    }
    owner.abort.abort();
    owner.removeAbortListener();
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (!owner.desktopLost) {
      await this.releaseInput();
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
    void this.exclusive(() => this.release()).catch((err) =>
      log.warn({ err }, "Desktop automation session cleanup failed"),
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
        log.warn(
          { err },
          "Desktop automation session availability check failed",
        );
        cancel();
      }
    }, 1_000);
    this.watchdog.unref?.();
    try {
      await this.deps.manager().ensureDesktopRunning();
      owner.abort.signal.throwIfAborted();
      this.assertAvailable();
      await this.releaseInput();
      return owner;
    } catch (err) {
      await this.release().catch((cleanupError) =>
        log.warn(
          { err: cleanupError },
          "Desktop automation session cleanup failed",
        ),
      );
      throw err;
    }
  }

  runBrowser(
    context: ToolContext,
    operation: (signal: AbortSignal) => Promise<ToolExecutionResult>,
    done = false,
  ): Promise<ToolExecutionResult> {
    return this.run(context, ({ signal }) => operation(signal), {
      done,
      autoInstall: true,
    });
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
      autoInstall?: boolean;
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
          "Desktop automation session requires an identified guardian conversation",
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
        return {
          content: "Desktop automation session released.",
          isError: false,
        };
      }
      context.signal?.throwIfAborted();
      try {
        if (
          options.autoInstall &&
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
            "Desktop automation session was interrupted. Observe again before continuing.",
          isError: true,
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
          log.warn(
            { err: cleanupError },
            "Desktop automation session cleanup failed",
          ),
        );
        throw err;
      }
    });
  }
}

export const desktopAutomationLease = new DesktopAutomationLease();

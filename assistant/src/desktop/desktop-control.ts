import { getConfig } from "../config/loader.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { desktopDependencyInstaller } from "./desktop-dependencies.js";
import { isAssistantDesktopEnabled } from "./desktop-feature.js";
import {
  desktopActionSchema,
  type DesktopInput,
  type DesktopObservation,
  X11DesktopInput,
} from "./desktop-input.js";
import {
  type DesktopSessionManager,
  type DesktopViewer,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";

const log = getLogger("desktop-control");
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIONS = 100;
export type DesktopControlStatus = { state: "idle" | "assistant" | "human" };
type Owner = {
  conversationId: string;
  actorId: string;
  abort: AbortController;
  holder: DesktopViewer;
  removeAbortListener: () => void;
  observation?: { id: string; width: number; height: number };
  actions: number;
  lastActivity: number;
};

export class DesktopControl {
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
      input: DesktopInput;
      notify: () => Promise<unknown>;
    } = {
      enabled: () => isAssistantDesktopEnabled(getConfig()),
      ready: () => desktopDependencyInstaller.getStatus().state === "ready",
      manager: getDesktopSessionManager,
      input: new X11DesktopInput(),
      notify: () => publishSyncInvalidation([SYNC_TAGS.assistantDesktop]),
    },
  ) {}

  getStatus(): DesktopControlStatus {
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

  async takeControl(): Promise<DesktopControlStatus> {
    this.humanControl = true;
    this.generation += 1;
    this.owner?.abort.abort();
    return this.exclusive(async () => {
      await this.release();
      this.notify();
      return this.getStatus();
    });
  }

  allowAssistant(): Promise<DesktopControlStatus> {
    return this.exclusive(async () => {
      if (!this.deps.enabled()) {
        throw new Error("Desktop control is not available on this assistant");
      }
      this.humanControl = false;
      this.generation += 1;
      this.notify();
      return this.getStatus();
    });
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
      try {
        await this.deps.input.releaseInput();
      } finally {
        await this.deps.input.setViewerInput(true);
      }
      this.inputCleanupPending = false;
    } finally {
      if (owner) {
        this.deps.manager().releaseAutomationSlot(owner.holder);
      }
      this.owner = null;
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

  private async claim(context: ToolContext): Promise<Owner> {
    const holder: DesktopViewer = { onDesktopLost: () => this.cancel(owner) };
    const owner: Owner = {
      conversationId: context.conversationId,
      actorId: context.sourceActorPrincipalId!,
      abort: new AbortController(),
      holder,
      actions: 0,
      lastActivity: Date.now(),
      removeAbortListener: () => {},
    };
    const slot = this.deps.manager().acquireAutomationSlot(holder);
    if (!slot.ok) {
      throw new Error("The desktop is busy or shutting down");
    }
    this.owner = owner;
    const cancel = () => this.cancel(owner);
    context.signal?.addEventListener("abort", cancel, { once: true });
    owner.removeAbortListener = () =>
      context.signal?.removeEventListener("abort", cancel);
    this.watchdog = setInterval(() => {
      try {
        if (
          Date.now() - owner.lastActivity > IDLE_TIMEOUT_MS ||
          !this.deps.enabled()
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
      await this.deps.input.setViewerInput(false);
      await this.deps.input.releaseInput();
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

  execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const generation = this.generation;
    return this.exclusive(async () => {
      const action = desktopActionSchema.parse(input);
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
      if (action.action === "done") {
        await this.release();
        return { content: "Desktop control released.", isError: false };
      }
      context.signal?.throwIfAborted();
      if (!this.deps.enabled()) {
        await this.release();
        throw new Error("Desktop control is not available on this assistant");
      }
      if (this.humanControl || generation !== this.generation) {
        return {
          content:
            "Desktop control was interrupted. The user can select Allow assistant in the desktop modal, then ask you to continue. Observe again before acting.",
          isError: true,
          yieldToUser: true,
        };
      }
      if (!this.deps.ready()) {
        throw new Error(
          "Open the desktop modal and select Install desktop before using desktop control",
        );
      }
      if (!this.owner && action.action !== "observe") {
        throw new Error("Observe the desktop before acting");
      }
      const owner = this.owner ?? (await this.claim(context));
      const signal = context.signal
        ? AbortSignal.any([context.signal, owner.abort.signal])
        : owner.abort.signal;
      owner.lastActivity = Date.now();
      signal.throwIfAborted();
      try {
        if (action.action !== "observe") {
          if (action.observation_id !== owner.observation?.id) {
            throw new Error(
              "Stale desktop observation. Observe again before acting.",
            );
          }
          if (
            "x" in action &&
            (action.x >= owner.observation.width ||
              action.y >= owner.observation.height ||
              (action.action === "drag" &&
                (action.to_x >= owner.observation.width ||
                  action.to_y >= owner.observation.height)))
          ) {
            throw new Error(
              "Coordinates must be inside the observed screenshot",
            );
          }
          owner.observation = undefined;
          if (++owner.actions > MAX_ACTIONS) {
            throw new Error(
              "Desktop action limit reached. Finish this session before continuing.",
            );
          }
          await this.deps.input.perform(action, signal);
        }
        const observation = await this.deps.input.observe(signal);
        signal.throwIfAborted();
        return this.result(owner, observation);
      } catch (err) {
        await this.release().catch((cleanupError) =>
          log.warn({ err: cleanupError }, "Desktop control cleanup failed"),
        );
        throw err;
      }
    });
  }

  private result(
    owner: Owner,
    observation: DesktopObservation,
  ): ToolExecutionResult {
    const id = crypto.randomUUID();
    owner.observation = {
      id,
      width: observation.width,
      height: observation.height,
    };
    return {
      isError: false,
      content: `Assistant desktop screenshot: ${observation.width}x${observation.height} pixels. observation_id: ${id}. Use coordinates in this image.`,
      contentBlocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: observation.png.toString("base64"),
          },
        },
      ],
    };
  }
}

export const desktopControl = new DesktopControl();

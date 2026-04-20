/**
 * Avatar feature (extension background wiring).
 *
 * The meet-bot's TalkingHead.js renderer runs **inside the extension**,
 * not in the bot's Node runtime — TalkingHead.js needs a real
 * `<canvas>` + WebGL context, which only a browser tab can provide.
 *
 * This module is the background-service-worker side of the feature:
 *
 * 1. On `avatar.start` from the bot, open a pinned, inactive second
 *    Chrome tab pointed at `chrome-runtime-url("avatar/avatar.html")`.
 *    The tab loads TalkingHead.js, instantiates the bundled GLB, and
 *    sends back an `avatar.started` ack once it has mounted.
 *
 * 2. Forward subsequent `avatar.push_viseme` frames from the bot to
 *    the avatar tab via `chrome.tabs.sendMessage`.
 *
 * 3. Relay inbound `avatar.frame` events from the avatar tab to the
 *    bot's native-messaging host unchanged.
 *
 * 4. On `avatar.stop` from the bot, remove the tab and drop state.
 *
 * ## Why a second tab?
 *
 * The Meet tab hosts Google's SPA; its CSP and aggressive DOM
 * virtualization make it a poor host for TalkingHead.js. A dedicated
 * tab with its own origin (the extension's `chrome-extension://`
 * scheme) sidesteps both concerns.
 *
 * The tab is opened `pinned: true, active: false`. Xvfb never renders
 * anything the user sees (there is no user inside the bot container)
 * but pinning prevents Chrome's tab-discard heuristic from freezing
 * the avatar's animation loop when the Meet tab is "active".
 *
 * ## Failure modes
 *
 * - If `chrome.tabs.create` rejects (extension context unavailable
 *   because Chrome itself is shutting down) we log and drop the
 *   command. The bot side's `start()` will time out waiting for the
 *   ack and throw `AvatarRendererUnavailableError`, letting the
 *   session-manager fall back to the noop renderer.
 * - If the avatar tab posts a message while no tab is active (race
 *   during teardown), we ignore it — dropping stale frames is
 *   strictly preferable to forwarding to a torn-down bot.
 */

import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";
import { ExtensionToBotMessageSchema } from "../../../contracts/native-messaging.js";

import type { NativePort } from "../messaging/native-port.js";

/**
 * Relative path to the bundled avatar HTML inside the extension.
 * `chrome.runtime.getURL` translates this into the
 * `chrome-extension://<id>/avatar/avatar.html` URL the opened tab
 * loads.
 */
export const AVATAR_PAGE_PATH = "avatar/avatar.html";

/**
 * Query-string key the avatar page reads at load time to determine
 * which GLB to load. When absent, the page falls back to the bundled
 * `default-avatar.glb`.
 */
export const AVATAR_MODEL_QUERY_PARAM = "model";

/**
 * Query-string key the avatar page reads at load time to determine the
 * capture cadence. When absent, the page uses its default target fps.
 */
export const AVATAR_FPS_QUERY_PARAM = "fps";

/**
 * Minimal slice of the Chrome tabs API the feature actually uses.
 * Exposed as a type so unit tests can inject a fake without needing
 * `@types/chrome` at the test-site.
 */
export interface AvatarTabsApi {
  create(opts: {
    url: string;
    active?: boolean;
    pinned?: boolean;
  }): Promise<{ id?: number }>;
  remove(tabId: number): Promise<void>;
  sendMessage(tabId: number, msg: unknown): Promise<unknown>;
}

/**
 * Minimal slice of the Chrome runtime API the feature uses. The
 * `onMessage.addListener` signature mirrors the real Chrome API so the
 * fake's shape stays compatible.
 */
export interface AvatarRuntimeApi {
  onMessage: {
    addListener(
      cb: (
        raw: unknown,
        sender: unknown,
        sendResponse: (response?: unknown) => void,
      ) => boolean,
    ): void;
  };
  getURL(path: string): string;
}

/**
 * Minimal slice of the native port the feature uses. `post` is the
 * only direction the avatar feature drives — it never registers its
 * own inbound listener (the background service worker's main router
 * does that and dispatches to `handleAvatarBotCommand`).
 */
export type AvatarNativePort = Pick<NativePort, "post">;

export interface AvatarFeatureOptions {
  tabs: AvatarTabsApi;
  runtime: AvatarRuntimeApi;
  port: AvatarNativePort;
  /**
   * Logger hooks — routed to `console` by default but overridable in
   * tests so we can assert diagnostic output without depending on
   * global console state.
   */
  log?: {
    info(msg: string, extra?: Record<string, unknown>): void;
    warn(msg: string, extra?: Record<string, unknown>): void;
  };
}

/**
 * Handle returned by {@link startAvatarFeature}. `stop()` is exposed
 * primarily for tests — the background service worker lives for the
 * lifetime of the extension and doesn't normally tear the feature
 * down.
 */
export interface AvatarFeatureHandle {
  /**
   * Dispatch a bot→extension avatar command. Called by the main
   * content bridge whenever it observes an `avatar.*` command on the
   * native port.
   */
  handleBotCommand(msg: BotToExtensionMessage): Promise<void>;
  /**
   * Tear the feature down and close any open avatar tab. Idempotent.
   * For tests.
   */
  stop(): Promise<void>;
}

/**
 * Wire up the avatar feature. Returns a handle the caller invokes
 * when routing bot commands.
 *
 * The caller is responsible for filtering bot commands to the
 * `avatar.*` family before handing them off — passing a non-avatar
 * command through `handleBotCommand` is a no-op but a caller is
 * expected to dispatch to the more specific handler (join/leave/etc.)
 * for everything else.
 */
export function startAvatarFeature(
  opts: AvatarFeatureOptions,
): AvatarFeatureHandle {
  const { tabs, runtime, port } = opts;
  const log = opts.log ?? {
    info: (m) => console.log(`[meet-ext avatar] ${m}`),
    warn: (m) => console.warn(`[meet-ext avatar] ${m}`),
  };

  let avatarTabId: number | null = null;
  let stopped = false;

  /**
   * Forward every validated inbound runtime message from the avatar
   * tab to the bot's native-messaging host. We only relay
   * `avatar.started` and `avatar.frame` — other message types are
   * ignored because they belong to the content-bridge router.
   */
  runtime.onMessage.addListener((raw, _sender, _sendResponse): boolean => {
    if (stopped) return false;
    const parsed = ExtensionToBotMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const msg: ExtensionToBotMessage = parsed.data;
    if (msg.type !== "avatar.started" && msg.type !== "avatar.frame") {
      return false;
    }
    try {
      port.post(msg);
    } catch (err) {
      log.warn("failed to forward avatar message to native port", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  });

  async function openAvatarTab(
    modelUrl: string | undefined,
    targetFps: number | undefined,
  ): Promise<void> {
    const base = runtime.getURL(AVATAR_PAGE_PATH);
    const params = new URLSearchParams();
    if (modelUrl) params.set(AVATAR_MODEL_QUERY_PARAM, modelUrl);
    if (typeof targetFps === "number") {
      params.set(AVATAR_FPS_QUERY_PARAM, String(targetFps));
    }
    const query = params.toString();
    const url = query ? `${base}?${query}` : base;
    try {
      const tab = await tabs.create({ url, active: false, pinned: true });
      if (typeof tab.id !== "number") {
        log.warn("tabs.create returned no tab id; avatar frames will not flow");
        return;
      }
      avatarTabId = tab.id;
      log.info(`avatar tab opened (id=${tab.id})`);
    } catch (err) {
      log.warn("tabs.create for avatar tab failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function closeAvatarTab(): Promise<void> {
    const id = avatarTabId;
    avatarTabId = null;
    if (id === null) return;
    try {
      await tabs.remove(id);
    } catch (err) {
      // Tab might already be gone (user tore down Chrome). Best-effort.
      log.warn("tabs.remove for avatar tab failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function relayToAvatarTab(msg: BotToExtensionMessage): Promise<void> {
    const id = avatarTabId;
    if (id === null) {
      // Viseme without an open tab: drop silently. The bot's
      // amplitude-envelope fallback (PR 9) may produce a burst of
      // visemes before the tab has landed; logging every drop would
      // swamp the diagnostic stream.
      return;
    }
    try {
      await tabs.sendMessage(id, msg);
    } catch (err) {
      log.warn("tabs.sendMessage to avatar tab failed", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleBotCommand(msg: BotToExtensionMessage): Promise<void> {
    if (stopped) return;
    if (msg.type === "avatar.start") {
      // Close any stale tab before opening a fresh one — a racing
      // start/start sequence must not leak tabs.
      if (avatarTabId !== null) {
        await closeAvatarTab();
      }
      await openAvatarTab(msg.modelUrl, msg.targetFps);
      return;
    }
    if (msg.type === "avatar.stop") {
      await closeAvatarTab();
      return;
    }
    if (msg.type === "avatar.push_viseme") {
      await relayToAvatarTab(msg);
      return;
    }
    // Any other message type is ignored — the content-bridge router
    // handles join / leave / send_chat.
  }

  return {
    handleBotCommand,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await closeAvatarTab();
    },
  };
}

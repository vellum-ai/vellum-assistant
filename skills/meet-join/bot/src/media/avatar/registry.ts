/**
 * Pluggable avatar-renderer factory registry.
 *
 * Each concrete renderer backend (TalkingHead.js, Simli, HeyGen, Tavus,
 * SadTalker, MuseTalk, …) registers a factory keyed by its stable id at
 * module import time:
 *
 * ```ts
 * registerAvatarRenderer("simli", (config, deps) => new SimliRenderer(...));
 * ```
 *
 * The session-manager (daemon) resolves the configured renderer at
 * `/avatar/enable` time via {@link resolveAvatarRenderer}, which walks
 * the registered factories and either returns a fresh instance or
 * throws {@link AvatarRendererUnavailableError} with a human-readable
 * reason the HTTP server can relay back to the caller.
 *
 * This module does not import any concrete renderer. Registration is
 * side-effectful: the entry point that wants a given backend available
 * imports that backend's module for its import-time side effect
 * (`import "./backends/simli-renderer.js"`). The noop renderer (in
 * `./noop-renderer.ts`) is the only renderer this module ships with out
 * of the box, and it self-registers when that file is imported.
 *
 * The registry is process-local and deliberately simple — no LRU, no
 * multi-tenancy, no lifecycle-aware caching. Each `resolveAvatarRenderer`
 * call constructs a fresh renderer; the session-manager owns the
 * instance and tears it down on `/avatar/disable` or meeting end. The
 * factory's only job is to turn a validated config object + deps into a
 * working renderer instance (or fail fast with
 * {@link AvatarRendererUnavailableError}).
 */

import type {
  BotAvatarPushVisemeCommand,
  BotAvatarStartCommand,
  BotAvatarStopCommand,
  ExtensionToBotMessage,
} from "../../../../contracts/native-messaging.js";

import {
  AvatarRendererUnavailableError,
  type AvatarRenderer,
} from "./types.js";

/**
 * Narrow slice of the NMH socket server the TalkingHead renderer (and
 * any future extension-mediated renderer) uses to talk to the Chrome
 * extension. Scoped to avatar-only message types so a buggy renderer
 * cannot smuggle a `join`/`leave`/`send_chat` through this surface.
 *
 * The bot's `main.ts` wires a wrapper around {@link NmhSocketServer}
 * that narrows to exactly the three avatar commands. Tests pass an
 * in-memory fake that captures sent frames.
 */
export interface AvatarNativeMessagingSender {
  /** Send one of the avatar.* commands. Throws if no extension is connected. */
  sendToExtension: (
    msg:
      | BotAvatarStartCommand
      | BotAvatarStopCommand
      | BotAvatarPushVisemeCommand,
  ) => void;
  /**
   * Register a handler for every inbound extension→bot message. The
   * TalkingHead renderer filters for `avatar.started` / `avatar.frame`
   * and ignores every other type (which is handled by the bot's main
   * message router).
   */
  onExtensionMessage: (cb: (msg: ExtensionToBotMessage) => void) => void;
}

/**
 * Dependencies the daemon hands to every renderer factory. Renderers
 * use whichever fields they need and ignore the rest — the optional
 * fields let the shape grow additively as new renderer backends arrive
 * without breaking existing factories.
 */
export interface AvatarRendererDeps {
  /** Minimal structured-logger surface. No-ops when omitted. */
  logger?: {
    info(msg: string, extra?: Record<string, unknown>): void;
    warn(msg: string, extra?: Record<string, unknown>): void;
    error(msg: string, extra?: Record<string, unknown>): void;
  };
  /**
   * Native-messaging surface the TalkingHead.js renderer uses to
   * drive the extension-hosted avatar tab. Absent when the bot is
   * booted without a live socket server (tests, smoke builds) — the
   * renderer must throw {@link AvatarRendererUnavailableError} when
   * it's not wired and a caller asks for TalkingHead specifically.
   */
  nativeMessaging?: AvatarNativeMessagingSender;
}

/**
 * Shape of the per-renderer configuration object handed to a factory.
 *
 * Factories receive the full `services.meet.avatar.*` config block the
 * daemon resolved from its config file. Renderer-specific sub-objects
 * (e.g. `simli`, `talkingHead`) are addressed by key inside the factory
 * — each factory knows which sub-object it depends on and fails fast
 * (via {@link AvatarRendererUnavailableError}) when its sub-object is
 * missing or malformed. Credentials are resolved through the vault in
 * the daemon before `config` reaches the bot, so any string field in
 * this object is already safe to read directly.
 *
 * The shape is permissive (`Record<string, unknown>`) so the bot side
 * of the package doesn't have to import zod or the full MeetService
 * schema — keeps the bot's build slim and keeps renderer factories
 * independent of any one schema revision.
 */
export type AvatarConfig = Record<string, unknown> & {
  /** Renderer id the daemon resolved. Always present. */
  renderer: string;
  /** Whether the feature is enabled. Always present. */
  enabled: boolean;
};

/**
 * Signature every avatar-renderer factory implements. Factories may be
 * synchronous; use `async` only inside the renderer's `start()` method
 * so the registry can remain a plain map.
 *
 * Construction errors — missing credentials, bad endpoints, unreachable
 * GPU sidecar — must throw {@link AvatarRendererUnavailableError}. The
 * session-manager catches that specific error and degrades to the noop
 * renderer; any other thrown error is treated as an unexpected bug and
 * surfaces as a 500 at the HTTP layer.
 */
export type AvatarRendererFactory = (
  config: AvatarConfig,
  deps: AvatarRendererDeps,
) => AvatarRenderer;

/**
 * Module-local factory map. Keyed by the stable renderer id
 * (e.g. `"noop"`, `"talking-head"`). Later registrations for the same
 * id replace earlier ones — this matters for tests that swap a real
 * factory for a fake via the same id, and for renderer PRs that
 * intentionally shadow a placeholder.
 */
const factories = new Map<string, AvatarRendererFactory>();

/**
 * Register a factory for a given renderer id. Called at import time by
 * the renderer's module. Safe to call multiple times for the same id —
 * the most recent registration wins, which lets tests override a
 * production factory with a fake.
 */
export function registerAvatarRenderer(
  id: string,
  factory: AvatarRendererFactory,
): void {
  factories.set(id, factory);
}

/**
 * Look up whether a renderer id is currently registered. Exposed so
 * the HTTP layer can decide between "not registered → 503" vs
 * "construction failed → 503 with a reason" before calling the factory.
 */
export function isAvatarRendererRegistered(id: string): boolean {
  return factories.has(id);
}

/**
 * List every registered renderer id. Used by `/avatar/status`-style
 * diagnostics and by unit tests that want to assert "this entry point
 * registered exactly the factories I expected".
 */
export function listRegisteredAvatarRenderers(): string[] {
  return Array.from(factories.keys()).sort();
}

/**
 * Resolve the configured renderer to an {@link AvatarRenderer}
 * instance.
 *
 * Behavior:
 * - Returns `null` when the feature is explicitly off
 *   (`config.enabled === false`) or the configured id is `"noop"`.
 *   Callers use the null return to short-circuit device-writer
 *   attachment — there's nothing to wire up.
 * - Throws {@link AvatarRendererUnavailableError} when the requested id
 *   isn't registered (typo, missing import, wrong build). The error's
 *   `reason` is a human-readable pointer at the registration step.
 * - Forwards any {@link AvatarRendererUnavailableError} the factory
 *   itself throws (missing credential, missing asset, unreachable
 *   sidecar). Other thrown errors propagate unchanged so a genuine
 *   factory bug doesn't get silently squashed into a 503.
 */
export function resolveAvatarRenderer(
  config: AvatarConfig,
  deps: AvatarRendererDeps,
): AvatarRenderer | null {
  if (!config.enabled) return null;
  if (config.renderer === "noop") return null;

  const factory = factories.get(config.renderer);
  if (!factory) {
    throw new AvatarRendererUnavailableError(
      config.renderer,
      `no factory registered for id "${config.renderer}" (available: ${
        listRegisteredAvatarRenderers().join(", ") || "<none>"
      })`,
    );
  }

  return factory(config, deps);
}

/**
 * Drop every registration. For tests only — production code has no
 * reason to call this. Exposed as a clearly-named export so test files
 * can reset the registry between suites without reaching into module
 * internals.
 */
export function __resetAvatarRegistryForTests(): void {
  factories.clear();
}

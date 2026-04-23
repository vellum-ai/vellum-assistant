/**
 * `SkillHost` — the runtime-injected contract a skill receives instead of
 * reaching into `assistant/` directly.
 *
 * This module is type-only. No runtime code lives here — every declaration
 * is an `interface` or `type`, so importing from this file contributes zero
 * bytes to a compiled bundle and keeps the contracts package free of any
 * dependency on `assistant/`.
 *
 * ### Opaque placeholder types
 *
 * Several types referenced by `SkillHost` (LLM provider handles, STT/TTS
 * provider handles, memory wake-request shape, speaker tracker, etc.) have
 * their authoritative definitions in `assistant/src/`. Moving every one of
 * them into this neutral package would pull in a large transitive closure
 * (CES contracts, config schemas, per-domain message types, …) that the
 * skill-isolation plan explicitly wants to avoid for the PR-6 slice.
 *
 * Instead, this file declares **opaque placeholder interfaces / type
 * aliases** for the daemon-internal shapes. Skills pass these values
 * through the host API without inspecting their internals; the daemon-side
 * implementation of `SkillHost` (see `DaemonSkillHost` in PR 7) narrows
 * them back to their concrete types at its boundary. This mirrors the
 * pattern already used by `tool-types.ts` for `ToolContext` fields like
 * `cesClient` and `hostBashProxy`.
 *
 * ### What lives where
 *
 * - Surface-level payload types that skills construct or read
 *   (`AssistantEvent`, `ServerMessage`, `Tool`, `DaemonRuntimeMode`) live
 *   in sibling files of this package and are imported here.
 * - Daemon-internal handles (`Provider`, `TtsProvider`, `SttSpec`, …) are
 *   opaque in this file.
 * - Structural helpers with no daemon dependency (`Logger`, `Filter`,
 *   `Subscription`, `SkillRoute`, `SkillRouteHandle`) are declared here in
 *   full.
 */

import type { AssistantEvent } from "./assistant-event.js";
import type { DaemonRuntimeMode } from "./runtime-mode.js";
import type { ServerMessage } from "./server-message.js";
import type { Tool } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Logger — minimal structural interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural logger. Compatible with the daemon's `getLogger`
 * return type at its use sites: four severity methods, each accepting a
 * human-readable message and an optional metadata payload. Skills use
 * `host.logger.get(<name>)` to obtain an instance; the name is opaque and
 * purely for log-scoping on the host side.
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface LoggerFacet {
  get(name: string): Logger;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigFacet {
  /**
   * Resolve an assistant feature flag by kebab-case key. Returns `true`
   * when the flag is enabled for this assistant (per registry default and
   * any user overrides).
   */
  isFeatureFlagEnabled(key: string): boolean;
  /**
   * Read a typed section from the assistant's resolved config. The `path`
   * is a dot-separated key into the config tree (e.g. `"services.meet"`).
   * Returns `undefined` when the section is not present. The daemon
   * redacts / validates the payload before it reaches the skill; skills
   * should still runtime-validate any security-critical fields.
   */
  getSection<T>(path: string): T | undefined;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface IdentityFacet {
  /**
   * Current display name for the assistant, if configured. Returns
   * `undefined` when no name has been set.
   */
  getAssistantName(): string | undefined;
  /**
   * The daemon's internal assistant id (`DAEMON_INTERNAL_ASSISTANT_ID`).
   * Skills use this as the `assistantId` field on events they publish and
   * as the subject of memory writes.
   */
  readonly internalAssistantId: string;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export interface PlatformFacet {
  /** Absolute path to the current workspace directory (`getWorkspaceDir()`). */
  workspaceDir(): string;
  /** Absolute path to the Vellum data root (`vellumRoot()`). */
  vellumRoot(): string;
  /** Current runtime mode (bare-metal vs Docker). */
  runtimeMode(): DaemonRuntimeMode;
}

// ---------------------------------------------------------------------------
// Providers
//
// All concrete provider handle types are owned by `assistant/` — the skill
// never introspects them, it just threads them back through `host.*`
// methods. Declaring them opaquely here lets the package stay free of any
// provider-SDK transitive dependencies.
// ---------------------------------------------------------------------------

/** Opaque LLM provider handle (narrowed by the daemon to the concrete provider union). */
export type Provider = unknown;

/** Opaque "user message" content envelope accepted by `providers.llm.complete` style APIs. */
export type UserMessage = unknown;

/** Opaque `tool_use` content block extracted from an LLM response. */
export type ToolUse = unknown;

export interface LlmProvidersFacet {
  /** Resolve the provider configured for the given LLM call site. */
  getConfigured(callSite: string): Provider;
  /** Wrap plain text into the provider's user-message envelope shape. */
  userMessage(text: string): UserMessage;
  /** Pull the first `tool_use` block out of a completion response, if any. */
  extractToolUse(response: unknown): ToolUse | null;
  /**
   * Produce an `AbortController` that aborts after `ms` milliseconds.
   * Callers pass `controller.signal` into the LLM request to enforce a
   * per-call deadline.
   */
  createTimeout(ms: number): AbortController;
}

/** Opaque STT spec (skill passes an instance obtained from config through). */
export type SttSpec = unknown;

/** Opaque streaming transcriber handle. */
export type StreamingTranscriber = unknown;

export interface SttProvidersFacet {
  listProviderIds(): string[];
  supportsBoundary(id: string): boolean;
  resolveStreamingTranscriber(spec: SttSpec): StreamingTranscriber;
}

/** Opaque TTS provider handle. */
export type TtsProvider = unknown;

/** Opaque TTS runtime config. */
export type TtsConfig = unknown;

export interface TtsProvidersFacet {
  get(id: string): TtsProvider;
  resolveConfig(): TtsConfig;
}

export interface SecureKeysFacet {
  /** Retrieve a provider API key from the secure credential store, or `null` if absent. */
  getProviderKey(id: string): Promise<string | null>;
}

export interface ProvidersFacet {
  llm: LlmProvidersFacet;
  stt: SttProvidersFacet;
  tts: TtsProvidersFacet;
  secureKeys: SecureKeysFacet;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Callable signature for `memory.addMessage`. Mirrors the daemon's
 * `addMessage()` (in `assistant/src/memory/conversation-crud.ts`) shape.
 * The return type is left as `unknown` because the daemon has additional
 * fields (message id, metadata echo) that skills should not depend on.
 */
export type InsertMessageFn = (
  conversationId: string,
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  opts?: { skipIndexing?: boolean },
) => Promise<unknown>;

/** Opaque payload passed to `memory.wakeAgentForOpportunity`. */
export type WakeOpportunity = unknown;

export interface MemoryFacet {
  addMessage: InsertMessageFn;
  wakeAgentForOpportunity(req: WakeOpportunity): Promise<void>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Subscription filter mirroring `AssistantEventFilter` from the daemon's hub. */
export interface Filter {
  /** Only deliver events for this assistant. */
  assistantId: string;
  /** When set, further restrict to this conversation. */
  conversationId?: string;
}

/** Callback invoked for each event that matches a subscriber's filter. */
export type AssistantEventCallback = (
  event: AssistantEvent,
) => void | Promise<void>;

/** Opaque handle returned by `events.subscribe`. Calling `dispose()` unsubscribes. */
export interface Subscription {
  dispose(): void;
  readonly active: boolean;
}

export interface EventsFacet {
  publish(event: AssistantEvent): Promise<void>;
  subscribe(filter: Filter, cb: AssistantEventCallback): Subscription;
  buildEvent(
    message: ServerMessage,
    conversationId?: string,
  ): AssistantEvent;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** Skill-provided HTTP route registration (subset of `assistant/`'s full type). */
export interface SkillRoute {
  pattern: RegExp;
  methods: string[];
  handler: (req: Request, match: RegExpMatchArray) => Promise<Response>;
}

/**
 * Opaque handle returned from `registries.registerSkillRoute`. Callers must
 * retain it as a black box and pass it back to the daemon at teardown; it
 * has no observable fields.
 */
declare const skillRouteHandleBrand: unique symbol;
export interface SkillRouteHandle {
  readonly [skillRouteHandleBrand]: true;
}

export interface RegistriesFacet {
  /**
   * Register a provider that returns the skill's tool list. The provider
   * is invoked lazily by the daemon's tool registry (so feature-flag gates
   * are re-evaluated on every manifest build).
   */
  registerTools(provider: () => Tool[]): void;
  /** Register a skill-owned HTTP route. */
  registerSkillRoute(route: SkillRoute): SkillRouteHandle;
  /**
   * Register a shutdown hook. The daemon calls it during orderly shutdown;
   * the `reason` argument matches the daemon's own shutdown-reason string.
   */
  registerShutdownHook(
    name: string,
    hook: (reason: string) => Promise<void>,
  ): void;
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

/** Opaque speaker-identity tracker (concrete type is owned by `assistant/`). */
export type SpeakerIdentityTracker = unknown;

export interface SpeakersFacet {
  createTracker(): SpeakerIdentityTracker;
}

// ---------------------------------------------------------------------------
// Aggregate SkillHost
// ---------------------------------------------------------------------------

/**
 * Everything a skill needs from the daemon, grouped by concern. Provided
 * to the skill's `register(host)` entry point in place of the direct
 * `assistant/` imports skills used historically.
 *
 * Implementations:
 * - `DaemonSkillHost` (PR 7) — in-process bridge from each facet to the
 *   daemon's existing modules.
 * - `SkillHostClient` (PR 25) — IPC-backed implementation used once the
 *   skill runs out-of-process.
 */
export interface SkillHost {
  logger: LoggerFacet;
  config: ConfigFacet;
  identity: IdentityFacet;
  platform: PlatformFacet;
  providers: ProvidersFacet;
  memory: MemoryFacet;
  events: EventsFacet;
  registries: RegistriesFacet;
  speakers: SpeakersFacet;
}

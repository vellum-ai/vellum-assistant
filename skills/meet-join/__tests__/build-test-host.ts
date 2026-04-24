/**
 * `buildTestHost` — canonical `SkillHost` test-double builder for the
 * meet-join skill.
 *
 * Every meet-join unit test that needs a `SkillHost` should construct one
 * via this helper instead of instantiating the daemon's real
 * `DaemonSkillHost` (which drags in SQLite, the provider registry, the
 * event hub, etc.) or hand-rolling yet another ad-hoc fake.
 *
 * The skill-isolation plan (see `.private/plans/skill-isolation.md`,
 * PR 19) adds a guard test that forbids any TypeScript file under
 * `skills/` from importing `assistant/src/...` — test files included.
 * `buildTestHost()` is the escape valve that lets tests inject
 * behavior without reaching for those relative imports or the
 * `mock.module("../../../assistant/...")` pattern that historically
 * punched through the boundary.
 *
 * ## Shape
 *
 * The helper returns a fully populated `SkillHost` where every facet has
 * a harmless no-op default:
 *
 * - `logger.get` returns a silent logger whose four severity methods
 *   are `mock()` spies — each `get(name)` call returns a fresh set, so
 *   tests that want to assert against log output should replace the
 *   whole `logger` facet in their override.
 * - `events.publish`, `events.subscribe`, and every `registries.*`
 *   method are `mock()` spies — assert via `.mock.calls` on the default
 *   without overriding.
 * - `events.subscribe` returns an inert
 *   `{ dispose: () => {}, active: true }` subscription.
 * - Every other method returns a plausible no-op value (`undefined`,
 *   `null`, an empty array, etc.).
 *
 * Opaque placeholder types (`Provider`, `TtsProvider`, etc.) are stubbed
 * with `undefined` cast through `as unknown as T` — the contract
 * declares them as `unknown`, so this is type-safe at the boundary even
 * though the concrete daemon types are opaque to this package.
 *
 * ## Override pattern
 *
 * Callers pass a `Partial<SkillHost>` whose facets are spread *last*, so
 * any facet the test replaces wholesale overrides the default. Partial
 * overrides of a single method within a facet are not supported — if a
 * test wants to override just `host.events.publish`, it must pass a full
 * `events` facet object with the other methods populated from the
 * defaults (or re-spread the helper's defaults manually).
 *
 * This keeps the helper small and the contract with callers explicit:
 * facet-level replacement, not deep-merge, so there is no hidden merging
 * behavior that could silently mask a test's intent.
 *
 * ## Zero assistant/ imports
 *
 * Every type in this file comes from `@vellumai/skill-host-contracts`.
 * The helper does not import from `assistant/` directly or transitively —
 * that is the whole point: tests that use it stay on the skill side of
 * the isolation boundary.
 */

import type {
  AssistantEvent,
  AssistantEventCallback,
  ConfigFacet,
  EventsFacet,
  Filter,
  IdentityFacet,
  LlmProvidersFacet,
  Logger,
  LoggerFacet,
  MemoryFacet,
  PlatformFacet,
  Provider,
  ProvidersFacet,
  RegistriesFacet,
  SecureKeysFacet,
  ServerMessage,
  SkillHost,
  SkillRoute,
  SkillRouteHandle,
  SpeakerIdentityTracker,
  SpeakersFacet,
  SttProvidersFacet,
  StreamingTranscriber,
  Subscription,
  Tool,
  TtsConfig,
  TtsProvider,
  TtsProvidersFacet,
  UserMessage,
} from "@vellumai/skill-host-contracts";
import { buildAssistantEvent } from "@vellumai/skill-host-contracts";
import { mock } from "bun:test";

/**
 * Internal assistant id used by the in-memory event hub below. Mirrors the
 * daemon's `DAEMON_INTERNAL_ASSISTANT_ID` literal so tests that filter on
 * that id keep working without reaching into `assistant/`.
 */
export const TEST_INTERNAL_ASSISTANT_ID = "self";

/**
 * Silent default logger. Every severity method is a `mock()` spy so
 * tests that want to assert against log output can inspect the spy's
 * `.mock.calls`; tests that don't care get a no-op. Printing to the
 * real console by default would bury the actual assertion output
 * under unrelated chatter from the host under test.
 */
function silentLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function defaultLoggerFacet(): LoggerFacet {
  return {
    get: () => silentLogger(),
  };
}

function defaultConfigFacet(): ConfigFacet {
  return {
    // Default to flags-off so a test that forgets to override does not
    // accidentally exercise a flag-gated code path. Tests that want the
    // flag on pass `{ config: { isFeatureFlagEnabled: () => true, ... } }`.
    isFeatureFlagEnabled: () => false,
    getSection: () => undefined,
  };
}

function defaultIdentityFacet(): IdentityFacet {
  return {
    getAssistantName: () => "TestAssistant",
    internalAssistantId: "self",
  };
}

function defaultPlatformFacet(): PlatformFacet {
  return {
    workspaceDir: () => "/tmp/test-workspace",
    vellumRoot: () => "/tmp/test-vellum-root",
    runtimeMode: () => "bare-metal",
  };
}

function defaultLlmFacet(): LlmProvidersFacet {
  return {
    getConfigured: async () => null as unknown as Provider | null,
    userMessage: (text: string) =>
      ({ role: "user", content: text }) as unknown as UserMessage,
    extractToolUse: () => null,
    createTimeout: (ms: number) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
      };
    },
  };
}

function defaultSttFacet(): SttProvidersFacet {
  return {
    listProviderIds: () => [],
    supportsBoundary: () => false,
    resolveStreamingTranscriber: async () =>
      null as unknown as StreamingTranscriber | null,
  };
}

function defaultTtsFacet(): TtsProvidersFacet {
  return {
    get: () => undefined as unknown as TtsProvider,
    resolveConfig: () => undefined as unknown as TtsConfig,
  };
}

function defaultSecureKeysFacet(): SecureKeysFacet {
  return {
    getProviderKey: async () => null,
  };
}

function defaultProvidersFacet(): ProvidersFacet {
  return {
    llm: defaultLlmFacet(),
    stt: defaultSttFacet(),
    tts: defaultTtsFacet(),
    secureKeys: defaultSecureKeysFacet(),
  };
}

function defaultMemoryFacet(): MemoryFacet {
  return {
    addMessage: mock(async () => ({ id: "msg-test" })),
    wakeAgentForOpportunity: mock(async () => {}),
  };
}

function inertSubscription(): Subscription {
  return {
    dispose: () => {},
    active: true,
  };
}

function defaultEventsFacet(): EventsFacet {
  return {
    publish: mock(async (_event: AssistantEvent) => {}),
    subscribe: mock((_filter: Filter, _cb: AssistantEventCallback) =>
      inertSubscription(),
    ),
    // Mirror the shape `DaemonSkillHost.buildEvent` returns so tests that
    // round-trip a synthetic event through the publisher see a plausible
    // `AssistantEvent` rather than an obviously-bogus empty object.
    buildEvent: (message: ServerMessage, conversationId?: string) =>
      ({
        id: "evt-test",
        assistantId: "self",
        conversationId,
        emittedAt: "1970-01-01T00:00:00.000Z",
        message,
      }) as unknown as AssistantEvent,
  };
}

// Inert route-registration handle. The `SkillRouteHandle` interface carries
// only a unique-symbol brand so an empty frozen object satisfies the type
// after a cast — tests that care inspect the call-site `route` argument
// that the spy captured, not the handle.
function inertRouteHandle(): SkillRouteHandle {
  return Object.freeze({}) as unknown as SkillRouteHandle;
}

function defaultRegistriesFacet(): RegistriesFacet {
  return {
    registerTools: mock((_provider: () => Tool[]) => {}),
    registerSkillRoute: mock((_route: SkillRoute) => inertRouteHandle()),
    registerShutdownHook: mock(
      (_name: string, _hook: (reason: string) => Promise<void>) => {},
    ),
  };
}

function defaultSpeakersFacet(): SpeakersFacet {
  return {
    createTracker: () => ({}) as unknown as SpeakerIdentityTracker,
  };
}

/**
 * Build a no-op `SkillHost` test double. Pass `overrides` to replace any
 * facet wholesale; unreplaced facets fall back to the defaults above.
 */
export function buildTestHost(overrides: Partial<SkillHost> = {}): SkillHost {
  return {
    logger: defaultLoggerFacet(),
    config: defaultConfigFacet(),
    identity: defaultIdentityFacet(),
    platform: defaultPlatformFacet(),
    providers: defaultProvidersFacet(),
    memory: defaultMemoryFacet(),
    events: defaultEventsFacet(),
    registries: defaultRegistriesFacet(),
    speakers: defaultSpeakersFacet(),
    ...overrides,
  };
}

// Re-export `SkillHost` so tests can import the type alongside the
// helper from a single source:
//   `import { buildTestHost, type SkillHost } from "./build-test-host.js";`
// Other host-contract types remain importable directly from
// `@vellumai/skill-host-contracts` if a test needs one.
export type { SkillHost };

// ---------------------------------------------------------------------------
// In-memory event hub — minimal real fan-out for integration tests
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fan-out hub suitable for integration tests that need
 * to round-trip events through `host.events.publish` / `subscribe`. Mirrors
 * the production `AssistantEventHub`'s filtering rules (assistantId match,
 * optional conversationId narrowing) and offers a `facet()` helper that
 * returns an `EventsFacet` ready to drop into `buildTestHost({ events })`.
 *
 * Not a full reimplementation — no subscriber caps, no eviction, no
 * AggregateError semantics — just enough to drive tests that observe the
 * wire-level event flow. Tests that need finer-grained control (e.g.
 * asserting on `mock.calls`) should keep using `buildTestHost()`'s default
 * `mock`-backed `events` facet instead.
 */
export class InMemoryEventHub {
  private readonly subscribers = new Set<{
    filter: Filter;
    cb: AssistantEventCallback;
    active: boolean;
  }>();

  /** Number of currently active subscribers. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  async publish(event: AssistantEvent): Promise<void> {
    // Snapshot so a subscriber that self-unsubscribes mid-dispatch doesn't
    // mutate the Set we're iterating.
    for (const entry of Array.from(this.subscribers)) {
      if (entry.filter.assistantId !== event.assistantId) continue;
      if (
        event.conversationId != null &&
        entry.filter.conversationId != null &&
        entry.filter.conversationId !== event.conversationId
      ) {
        continue;
      }
      try {
        await entry.cb(event);
      } catch {
        // Test-only hub: swallow subscriber errors so one bad listener
        // cannot break fan-out for the others. Tests that need error
        // reporting should assert via their own spies.
      }
    }
  }

  subscribe(filter: Filter, cb: AssistantEventCallback): Subscription {
    const entry = { filter, cb };
    this.subscribers.add(entry);
    let active = true;
    return {
      dispose: () => {
        if (active) {
          active = false;
          this.subscribers.delete(entry);
        }
      },
      get active() {
        return active;
      },
    };
  }

  /**
   * Build an `EventsFacet` backed by this hub. `assistantId` defaults to
   * {@link TEST_INTERNAL_ASSISTANT_ID} — production code always constructs
   * events under the daemon-internal scope, so matching that here keeps
   * subscribers that filter on the internal id working without passing
   * the id through at every call site.
   */
  facet(assistantId: string = TEST_INTERNAL_ASSISTANT_ID): EventsFacet {
    return {
      publish: (event) => this.publish(event),
      subscribe: (filter, cb) => this.subscribe(filter, cb),
      buildEvent: (message: ServerMessage, conversationId?: string) =>
        buildAssistantEvent(assistantId, message, conversationId),
    };
  }
}

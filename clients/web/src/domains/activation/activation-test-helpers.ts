/**
 * The setup every activation suite needs, written once.
 *
 * Five test files were each carrying their own `fetch` stub, their own way of
 * putting the client on an arm, and their own copy of the `mock.module` dance
 * the progress hook needs. Copies of a stub drift the way any other copy does,
 * and the mock dance in particular has a rule that is easy to get wrong in one
 * of five places: `mock.module` replaces a module for every file sharing the
 * process, so a mock that does not spread the real module erases the rest of
 * its exports for whatever loads it next, and one that is never restored
 * outlives the file that installed it.
 *
 * Lives beside the fixtures rather than under a test directory because it is
 * the same kind of thing: production-shaped scaffolding the suites and the
 * stories share.
 */

import { mock } from "bun:test";

import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import type { ActivationProgress } from "./hooks/use-activation-progress";

/** One request the stub saw, with its body already parsed. */
export interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

export interface ActivationFetchStub {
  /** Every request the stub saw, in order. */
  requests: RecordedRequest[];
  /**
   * Status to answer with, keyed by a substring of the request url. Mutable,
   * so a test can flip one leg to a failure without reinstalling the stub.
   */
  statuses: Record<string, number>;
  /** Body to answer with, keyed by a substring of the request url. */
  bodies: Record<string, unknown>;
  /** Requests whose url contains `fragment`. */
  matching: (fragment: string) => RecordedRequest[];
  /** Puts the real `fetch` back. */
  restore: () => void;
}

export interface ActivationFetchStubOptions {
  statuses?: Record<string, number>;
  bodies?: Record<string, unknown>;
  /**
   * First refusal on every request, for a suite that has to park an answer,
   * throw instead of answering, or mint a body per call. Returning `undefined`
   * falls through to the status and body tables.
   */
  respond?: (
    request: RecordedRequest,
  ) => Response | undefined | Promise<Response | undefined>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The value whose key is the longest fragment of `url`, if any key matches. */
function lookup<T>(table: Record<string, T>, url: string): T | undefined {
  let matched: string | undefined;
  for (const fragment of Object.keys(table)) {
    if (
      url.includes(fragment) &&
      (matched === undefined || fragment.length > matched.length)
    ) {
      matched = fragment;
    }
  }
  return matched === undefined ? undefined : table[matched];
}

/**
 * Replace `globalThis.fetch` with a recorder that answers from two tables.
 *
 * Records rather than asserts: what a surface writes, and what it writes it
 * against, is the thing worth asserting on, and every suite wants a different
 * slice of it.
 */
export function installActivationFetchStub(
  options: ActivationFetchStubOptions = {},
): ActivationFetchStub {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const statuses: Record<string, number> = { ...options.statuses };
  const bodies: Record<string, unknown> = { ...options.bodies };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    let bodyText: string | undefined;
    if (input instanceof Request) {
      bodyText = await input.clone().text();
    } else if (typeof init?.body === "string") {
      bodyText = init.body;
    }
    const request: RecordedRequest = {
      url,
      method,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    };
    requests.push(request);

    const answered = await options.respond?.(request);
    if (answered) {
      return answered;
    }
    return jsonResponse(
      lookup(statuses, url) ?? 200,
      lookup(bodies, url) ?? {},
    );
  }) as typeof fetch;

  return {
    requests,
    statuses,
    bodies,
    matching: (fragment) =>
      requests.filter((request) => request.url.includes(fragment)),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * The flag store as this process found it, captured before any activation
 * suite has touched it.
 *
 * `use-marketing-pricing-takeover.test.ts` and `use-client-feature-flag-sync
 * .test.ts` both snapshot the store when their module loads and assert on the
 * unhydrated state, so a suite that leaves `hydrated` set breaks them from a
 * distance.
 */
const INITIAL_FLAG_STATE = useClientFeatureFlagStore.getState();

/** Put the flag store back the way {@link setActivationArm} found it. */
export function resetActivationFlagStore(): void {
  useClientFeatureFlagStore.setState(INITIAL_FLAG_STATE, true);
}

/**
 * Put the client on an arm of the `activation-checklist` flag.
 *
 * The values a server response carries and the fact that one has landed are
 * two writes on the flag store, and the gates wait for the second before
 * acting on the first, so a test that sets only the first is testing the
 * cold-load window rather than the arm it named.
 */
export function setActivationArm(arm: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
  useClientFeatureFlagStore.setState({ hydrated: true });
}

/**
 * Make `assistantId` the active assistant and give it a version.
 *
 * Both halves are needed: the activation gates read the version the identity
 * store holds AND which assistant it was fetched for, so an identity set
 * without the matching active id reads as another assistant's.
 */
export function seedActivationIdentity(
  assistantId: string,
  version: string = MIN_VERSION,
): void {
  useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
  useAssistantIdentityStore.getState().setIdentity("Vel", version, assistantId);
}

export interface ActivationProgressMock {
  /** What `useActivationProgress` answers with from here on. */
  set: (progress: ActivationProgress | undefined) => void;
  /** Puts the real hook back. Call from `afterAll`. */
  restore: () => void;
}

/**
 * Stub `useActivationProgress` at its hook seam, for a suite about what the
 * surfaces do with a snapshot rather than how one is fetched.
 *
 * Call at module scope, before importing whatever is under test, and hand the
 * `restore` to `afterAll`.
 */
export async function mockActivationProgress(): Promise<ActivationProgressMock> {
  const real =
    await import("@/domains/activation/hooks/use-activation-progress");
  // Captured by value: a module namespace's bindings are live, so reading the
  // export back after the mock is installed would hand out the mock.
  const { useActivationProgress: realHook } = real;
  let progress: ActivationProgress | undefined;
  mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
    ...real,
    useActivationProgress: () => ({ data: progress }),
  }));
  return {
    set: (next) => {
      progress = next;
    },
    restore: () => {
      mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
        ...real,
        useActivationProgress: realHook,
      }));
    },
  };
}

/** The fields an activation funnel event is asserted on. */
export interface ActivationFunnelEvent {
  step_name?: string;
  screen?: string;
  ab_variant?: string;
}

export interface ActivationFunnelRecorder {
  /** Every funnel event posted since the last {@link clear}, in order. */
  events: ActivationFunnelEvent[];
  /** Events whose `step_name` is `stepName`. */
  matching: (stepName: string) => ActivationFunnelEvent[];
  clear: () => void;
  /** Puts the real ingest back. Call from `afterAll`. */
  restore: () => void;
}

/**
 * Record the funnel events the activation surfaces emit, caught at the ingest
 * transport rather than at `emitActivationEvent`.
 *
 * `mock.module` replaces a module for every test file sharing the process, and
 * `use-launch-activation-task.test.tsx` claims `@/utils/activation-telemetry`;
 * a second file taking the same module would silently erase its mock in a
 * combined run. Catching one layer down leaves that module alone and asserts
 * the payload the emitter actually built.
 *
 * Call at module scope, before importing whatever is under test, and hand the
 * `restore` to `afterAll`.
 */
export async function recordActivationFunnelEvents(): Promise<ActivationFunnelRecorder> {
  const real = await import("@/lib/telemetry/ingest");
  // Captured by value: a module namespace's bindings are live, so reading the
  // export back after the mock is installed would hand out the mock.
  const { postTelemetryEvents: realPost } = real;
  const events: ActivationFunnelEvent[] = [];
  mock.module("@/lib/telemetry/ingest", () => ({
    ...real,
    postTelemetryEvents: (posted: readonly object[]) => {
      events.push(...(posted as ActivationFunnelEvent[]));
    },
  }));
  return {
    events,
    matching: (stepName) =>
      events.filter((event) => event.step_name === stepName),
    clear: () => {
      events.length = 0;
    },
    restore: () => {
      mock.module("@/lib/telemetry/ingest", () => ({
        ...real,
        postTelemetryEvents: realPost,
      }));
    },
  };
}

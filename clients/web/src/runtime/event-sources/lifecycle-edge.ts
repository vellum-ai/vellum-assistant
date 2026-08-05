/**
 * Collapses the two signal sources that describe the same physical
 * lifecycle edge into one bus publish: `document.visibilitychange`
 * (`runtime/event-sources/dom-visibility.ts`, `signal: "visibility"`) and
 * Capacitor `App.appStateChange`
 * (`runtime/event-sources/capacitor-app-state.ts`, `signal: "app_state"`).
 * Foregrounding the iOS native shell fires both within milliseconds, and
 * every `app.resume` subscriber that kicks off work would otherwise do it
 * twice. The bus therefore delivers at most one `app.resume` and one
 * `app.hidden` per physical edge for that pair.
 *
 * The first source to reach an edge wins it, and its `signal` label is the
 * one subscribers see. Which of the two arrives first is not fixed, so
 * consumers must treat `"visibility"` and `"app_state"` as interchangeable
 * descriptions of the same foreground or background transition.
 *
 * Only repeats of the SAME edge are dropped. The opposite edge always
 * publishes and restarts the window, so an `app.hidden` landing between two
 * resumes still reaches the SSE teardown policy (`assistant/sse-service.ts`
 * documents what a suppressed reopen would strand).
 *
 * `signal: "online"` resumes from `runtime/event-sources/window-online.ts`
 * are not routed through here. They report reachability rather than a
 * foreground edge, they have no second source to collapse against, and
 * consumers branch on the label (`lib/query-focus-manager.ts`).
 */

import { publish } from "@/lib/event-bus";

const LIFECYCLE_EDGE_DEDUP_MS = 1_000;

type LifecycleEdge = "resume" | "hidden";

/** The two signal sources that can describe a single lifecycle edge. */
type LifecycleEdgeSignal = "visibility" | "app_state";

let lastEdge: LifecycleEdge | null = null;
let lastAt = 0;

/**
 * Publish `app.resume` / `app.hidden` for a lifecycle edge, unless the same
 * edge was already published inside {@link LIFECYCLE_EDGE_DEDUP_MS}.
 *
 * A dropped publish does not extend the window: the timestamp stays on the
 * edge that won, so a source firing steadily just under the window cannot
 * starve the next real edge.
 */
export function publishLifecycleEdge(
  edge: LifecycleEdge,
  signal: LifecycleEdgeSignal,
): void {
  const now = Date.now();
  if (lastEdge === edge && now - lastAt < LIFECYCLE_EDGE_DEDUP_MS) {
    return;
  }
  lastEdge = edge;
  lastAt = now;
  if (edge === "resume") {
    publish("app.resume", { signal });
  } else {
    publish("app.hidden", { signal });
  }
}

export function __resetLifecycleEdgeForTests(): void {
  lastEdge = null;
  lastAt = 0;
}

/**
 * Covers the iOS widget-snapshot contract: the `inputsResolved` guard, the
 * payload the Home Screen widgets read, and the dedup that keeps a re-render
 * from costing bridge traffic and a widget timeline reload.
 *
 * The guard is the one the recent-chats sync carries, widened to both queries
 * the snapshot is built from: the conversation-list and conversation-groups
 * queries each serve an `[]` fallback while loading, gated, or errored, and
 * syncing that would blank the widgets on every launch (or drop every row's
 * group subtitle, when only the groups half is unresolved), and for as long
 * as the failure lasted on a launch that never loads. The caller ANDs the two
 * into this one flag. An empty list from *successful* queries must still
 * sync: genuinely having no conversations should empty the widgets.
 *
 * `generatedAt` is deliberately outside the dedup key. It changes on every
 * render by construction, so including it would leave the dedup dead.
 *
 * The key is armed from the bridge call's resolution, not from the render that
 * fired it, so a write the bridge rejected or never answered is retried by the
 * next run instead of being deduped away.
 *
 * Because `generatedAt` is outside that key, a session left open on unchanged
 * data would never move it, and the widget extension ages a snapshot out on its
 * own clock. So a heartbeat re-sends through the same send path on a bounded
 * interval, carrying the content the session currently WANTS the App Group to
 * hold rather than the one that last landed there: identical in the ordinary
 * case, and after a write the bridge never landed it is the retry instead of a
 * fresh stamp on outdated rows. It is armed only while the queries behind it
 * would fetch if asked, since resolution outlives the assistant: cached rows
 * from one that went inactive or whose pod stopped serving must age out on the
 * native clock rather than be re-stamped as current. bun ships no fake timers,
 * so `setInterval` and `clearInterval` are stubbed with the armed-timer capture
 * other hooks in this directory use, and the heartbeat's own delay picks its
 * timer out.
 *
 * The hook is also the seam that finishes a clear a previous session could not:
 * a sign-out or origin swap whose bridge call failed persists the obligation,
 * and a launch that reaches no sync of its own would otherwise never honor it.
 *
 * Retiring an attempt and ending a session are separate things here, and the
 * stand-in bridge keeps them separate. A write already on the bridge when the
 * hook unmounts is left where it lands, because an unmount alone is an app
 * closing or a layout swapping out; only the clear a sign-out issues takes such
 * a write back out, and nothing is then recorded as landed for it.
 *
 * The avatar rides along so the widgets can draw the user's own colors and
 * face. Its encoded bytes are deliberately outside the dedup key: they are
 * tens of kilobytes, the key is re-serialized on every list re-render, and an
 * identity in their place still tells one photo from the next. It is a
 * reactive input rather than a read taken as the payload is built, so a change
 * with no conversation change still re-runs the sync: `RootLayout` publishes
 * its own copies from a parent effect, which React runs after this layout's,
 * and a snapshot that read those back would pin the previous assistant's face
 * in the dedup key across an in-SPA switch into a cached destination.
 *
 * The avatar query is therefore in the resolution guard too, on this side of
 * the call rather than in the flag the caller passes. It settles after the
 * conversation list often enough to be the ordinary case on a cold launch, and
 * the plugin's write replaces the App Group record whole, so a first sync taken
 * while it loads wipes a themed avatar off every widget until a second one
 * repaints it. The encode behind it is the memo `avatar-island-encode` shares
 * with the Live Activity mirror, so these tests thread a stub through its
 * injection seam rather than restating its caching here. The stub goes in at
 * the rasterizer, below the ladder, because the distinction under test is one
 * the ladder draws: a rung that comes back over budget is a fact about the
 * avatar and is cached, while a draw that fails at all is the encoder failing
 * and has to reject its way out to the memo so the next read retries it.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, useSyncExternalStore, type ReactNode } from "react";

import type { AvatarData } from "@/hooks/use-assistant-avatar";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { WidgetSnapshotPayload } from "@/runtime/widget-snapshot";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import * as listFetchers from "@/utils/conversation-list-fetchers";

// Nothing in this file should reach the network: the count endpoint stands in
// as a request that never settles, so every case reads the derived fallback.
mock.module("@/utils/conversation-list-fetchers", () => ({
  ...listFetchers,
  fetchUnreadConversationCount: () => new Promise(() => {}),
}));

const syncedSnapshots: WidgetSnapshotPayload[] = [];
const syncedAssistantIds: (string | null)[] = [];
let clearCount = 0;
/** Every bridge call in order, for the claims that are about ordering. */
let bridgeOrder: string[] = [];
let syncAvailable = true;
// Stands in for the obligation the module persists when a clear does not land,
// which it finishes before anything a later session writes.
let pendingClear = false;
// Whether the bridge write lands. False stands in for both ways it can fail:
// a shell too old to carry the plugin rejects, and one that accepts the call
// without answering hits the module's two-second timeout. The hook sees the
// same reported `false` either way.
let syncLands = true;
// Holds the next write open once it is inside the module, so an unmount can
// arrive while the payload is on the bridge rather than only while it waits on
// the avatar draw.
let syncGate: Promise<void> | null = null;
// Stands in for the producer id the bridge persists beside the App Group
// snapshot, so a test can start from a snapshot a previous run left behind.
let persistedAssistantId: string | null = null;
// The module's clear generation, which every session-ending seam moves and a
// bare retirement never does. It is what decides whether a write that landed
// while its caller went away is corrected, so the stand-in has to carry it:
// modelling the correction on the retirement instead would let a supersession
// wipe the very snapshot that superseded it.
let clearGeneration = 0;

// Full module surface: `mock.module` is process-global in bun, so a partial
// shape would shadow the other exports for later test files in the run.
mock.module("@/runtime/widget-snapshot", () => ({
  WIDGET_SNAPSHOT_SCHEMA_VERSION: 2,
  isWidgetSnapshotSyncAvailable: () => syncAvailable,
  readWidgetSnapshotAssistantId: () => persistedAssistantId,
  syncWidgetSnapshot: async (
    snapshot: WidgetSnapshotPayload,
    assistantId: string | null,
  ) => {
    syncedSnapshots.push(snapshot);
    syncedAssistantIds.push(assistantId);
    bridgeOrder.push("sync");
    const generation = clearGeneration;
    if (syncGate !== null) {
      const gate = syncGate;
      syncGate = null;
      await gate;
    }
    if (!syncLands) {
      return false;
    }
    // A session-ending clear ran while the payload was on the bridge, so what
    // landed belongs to a session that is over: past the plugin it cannot be
    // held back, so the module takes it straight back out and reports that
    // nothing durable landed.
    if (generation !== clearGeneration) {
      runClear();
      return false;
    }
    // Anything else lands and stays, a write its caller retired included: a
    // supersession is overwritten by its successor, and a plain unmount is an
    // app closing, which should leave the Home Screen as it was. A landed write
    // replaces the whole App Group record, so it also settles any clear that
    // was owed for what used to be there.
    pendingClear = false;
    persistedAssistantId = assistantId;
    return true;
  },
  clearWidgetSnapshot: async () => {
    runClear();
    return true;
  },
  retryPendingWidgetSnapshotClear: async () => {
    if (!pendingClear) {
      return true;
    }
    runClear();
    return true;
  },
}));

/** One clear against the stand-in App Group, generation bump included. */
function runClear(): void {
  clearCount++;
  clearGeneration++;
  bridgeOrder.push("clear");
  persistedAssistantId = null;
  pendingClear = false;
}

// The session-ending clear as `endSession` and an origin swap issue it, taken
// from the stand-in above so a test can end a session under a write in flight
// exactly the way the app does.
const { clearWidgetSnapshot: endSessionClear } =
  await import("@/runtime/widget-snapshot");

/**
 * Let a fired bridge call settle. The hook arms its dedup key from the call's
 * resolution rather than from the render that fired it, so the tests that
 * depend on the key have to give the bridge a turn.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The avatar, as the hook reads it: the assistant-avatar query `RootLayout`
// derives its own published copies from. Mocked as an external store rather
// than as a plain getter because the hook SUBSCRIBES to it, and the claim under
// test is that a new avatar re-runs the sync with nothing else moving. The
// render and the accent come from the real resolvers, so the widget can only
// ever draw what the app does. The encode is stubbed because it rasterizes onto
// a canvas, which happy-dom does not have. Both mocked modules are spread over
// their real surface, since `mock.module` is process-global in bun.
const NO_AVATAR: AvatarData = {
  components: null,
  traits: null,
  customImageUrl: null,
};
/**
 * The query's whole return, loading flag included: the hook holds its first
 * sync until that flag clears, so it is state a test drives rather than a
 * constant.
 */
let avatarState: { data: AvatarData; isLoading: boolean } = {
  data: NO_AVATAR,
  isLoading: false,
};
const avatarListeners = new Set<() => void>();
let encodeOutcome: "bytes" | "nothing-fits" | "throws" | "held" = "bytes";
let encodeCalls = 0;
/** Resolver for a draw held open by the "held" outcome. */
let releaseHeldRasterize: ((bytes: Uint8Array | null) => void) | null = null;
/** Long enough that a dedup key carrying it would be unmistakable. */
const AVATAR_BASE64 = "Zm9vYmFy".repeat(2_000);
/**
 * The pixels behind it. "foobar" base64s to "Zm9vYmFy" and is a whole number of
 * base64 groups, so the repeats line up and the encoder's own base64 of these
 * bytes is exactly the string above.
 */
const AVATAR_BYTES = new TextEncoder().encode("foobar".repeat(2_000));
/** Past the widget's 64KB budget, so every rung of the ladder misses. */
const OVERSIZED_BYTES = new Uint8Array(100_000);

/** What the query serves from the next render on, without waking subscribers. */
function setAvatar(data: AvatarData, isLoading = false): void {
  avatarState = { data, isLoading };
}

/** Serve a new avatar the way a settling query does, waking its subscribers. */
function publishAvatar(next: AvatarData): void {
  setAvatar(next);
  for (const listener of avatarListeners) {
    listener();
  }
}

function subscribeAvatar(onChange: () => void): () => void {
  avatarListeners.add(onChange);
  return () => {
    avatarListeners.delete(onChange);
  };
}

const realAssistantAvatar = await import("@/hooks/use-assistant-avatar");
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...realAssistantAvatar,
  // The assistant id is ignored: one avatar is served at a time, which is what
  // the real query does too once the active assistant's entry settles.
  useAssistantAvatar: () => {
    const state = useSyncExternalStore(subscribeAvatar, () => avatarState);
    return { ...state.data, isLoading: state.isLoading, invalidate: () => {} };
  },
}));

const realAvatarIslandEncode = await import("@/utils/avatar-island-encode");
// Held before the mock is installed. `mock.module` updates live bindings, so a
// wrapper that reached back through the namespace object at call time would
// find itself rather than the real implementation.
const realEncodeAvatarForIsland = realAvatarIslandEncode.encodeAvatarForIsland;
const realMemoizedAvatarEncode = realAvatarIslandEncode.memoizedAvatarEncode;
const resetAvatarEncodeMemo =
  realAvatarIslandEncode.__resetAvatarEncodeMemoForTesting;

/**
 * Stands in for the canvas draw, which happy-dom has no canvas for.
 *
 * Stubbed at the RASTERIZER rather than at the encoder, so the real ladder runs
 * above it. Whether a failed draw is retried and a too-large one is cached is
 * decided by how `encodeAvatarForIsland` classifies each, and a stub installed
 * over that would be answering for the very thing under test.
 */
const stubRasterize = async (): Promise<Uint8Array | null> => {
  if (encodeOutcome === "throws") {
    throw new Error("canvas unavailable");
  }
  if (encodeOutcome === "held") {
    return new Promise((resolve) => {
      releaseHeldRasterize = resolve;
    });
  }
  return encodeOutcome === "bytes" ? AVATAR_BYTES : OVERSIZED_BYTES;
};

/** That ladder, counted, so a re-encode after a dropped slot is visible. */
const stubEncode = (
  render: Parameters<typeof realEncodeAvatarForIsland>[0],
  maxBytes?: number,
): Promise<string | null> => {
  encodeCalls++;
  return realEncodeAvatarForIsland(render, maxBytes, stubRasterize);
};

mock.module("@/utils/avatar-island-encode", () => ({
  ...realAvatarIslandEncode,
  encodeAvatarForIsland: stubEncode,
  // The REAL memo with the stub threaded through its injection seam, rather
  // than a second memo written here: what these tests claim about caching and
  // about retrying a failed encode is the shared helper's behavior, so it has
  // to be the shared helper that answers for it.
  memoizedAvatarEncode: (
    source: Parameters<typeof realMemoizedAvatarEncode>[0],
    maxBytes?: number,
  ) => realMemoizedAvatarEncode(source, maxBytes, stubEncode),
}));

/**
 * A character avatar in the palette color named, as the query serves one: a
 * distinct object each call, which is what a real avatar change produces.
 */
function characterAvatar(color: string): AvatarData {
  return {
    components: BUNDLED_COMPONENTS,
    traits: { bodyShape: "blob", eyeStyle: "grumpy", color },
    customImageUrl: null,
  };
}

function imageAvatar(url: string): AvatarData {
  return { components: null, traits: null, customImageUrl: url };
}

/** An assistant that has a palette but has never picked traits of its own. */
function defaultCharacterAvatar(): AvatarData {
  return { components: BUNDLED_COMPONENTS, traits: null, customImageUrl: null };
}

/** The hexes {@link characterAvatar}'s colors resolve to through the palette. */
const ORANGE_HEX = "#E9642F";
const TEAL_HEX = "#0E9B8B";
/** The first palette color, which is what the default character is drawn in. */
const GREEN_HEX = BUNDLED_COMPONENTS.colors[0]!.hex;

/** Everything `JSON.stringify` produced while `body` ran. */
function recordSerialized(body: () => void): string[] {
  const serialized: string[] = [];
  const real = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const result = real(...args);
    if (typeof result === "string") {
      serialized.push(result);
    }
    return result;
  }) as typeof JSON.stringify;
  try {
    body();
  } finally {
    JSON.stringify = real;
  }
  return serialized;
}

// The pod half of the queries' daemon gate. Spread over the real module: the
// rest of its surface is in this import graph, and `mock.module` is
// process-global in bun, so a bare object would shadow those exports for later
// test files in the run.
let podIsServing = true;
const realOperationalStatus = await import("@/assistant/operational-status");

mock.module("@/assistant/operational-status", () => ({
  ...realOperationalStatus,
  useAssistantIsServing: () => podIsServing,
}));

const { useConversationStore } = await import("@/stores/conversation-store");
const { useNativeWidgetSnapshotSync, WIDGET_SNAPSHOT_HEARTBEAT_MS } =
  await import("@/domains/chat/hooks/use-native-widget-snapshot-sync");

// --- setInterval capture ----------------------------------------------------

interface ArmedTimer {
  handler: () => void;
  delay: number;
  cleared: boolean;
}

let armedTimers: ArmedTimer[] = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** The heartbeat timers still armed, newest last. */
function liveHeartbeats(): ArmedTimer[] {
  return armedTimers.filter(
    (timer) => timer.delay === WIDGET_SNAPSHOT_HEARTBEAT_MS && !timer.cleared,
  );
}

/** Run the one armed heartbeat, failing loudly if the hook armed none. */
function fireHeartbeat(): void {
  const live = liveHeartbeats();
  expect(live).toHaveLength(1);
  live[0]?.handler();
}

const ASSISTANT_ID = "asst-1";
const NO_GROUPS: ConversationGroup[] = [];

function conversation(
  conversationId: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId,
    title: conversationId,
    lastMessageAt: Date.parse("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function group(id: string, name: string): ConversationGroup {
  return { id, name, sortPosition: 0, isSystemGroup: false };
}

interface Props {
  assistantId?: string | null;
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  /** The assistant-record gate the caller also passes the queries. */
  isAssistantActive?: boolean;
  inputsResolved: boolean;
}

function render(initialProps: Props) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(
    (props: Props) =>
      useNativeWidgetSnapshotSync(
        props.assistantId === undefined ? ASSISTANT_ID : props.assistantId,
        props.conversations,
        props.conversationGroups,
        props.isAssistantActive ?? true,
        props.inputsResolved,
      ),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );
}

beforeEach(() => {
  syncedSnapshots.length = 0;
  syncedAssistantIds.length = 0;
  clearCount = 0;
  clearGeneration = 0;
  bridgeOrder = [];
  syncAvailable = true;
  syncLands = true;
  syncGate = null;
  pendingClear = false;
  persistedAssistantId = null;
  podIsServing = true;
  armedTimers = [];
  setAvatar(NO_AVATAR);
  avatarListeners.clear();
  encodeOutcome = "bytes";
  encodeCalls = 0;
  releaseHeldRasterize = null;
  // The memo is module scope and shared with the Live Activity mirror, so a
  // slot left by an earlier case (or an earlier file in the run) would answer
  // for an avatar this one never encoded.
  resetAvatarEncodeMemo();
  useConversationStore.setState({ processingConversationIds: new Set() });

  globalThis.setInterval = ((handler: () => void, delay: number) => {
    armedTimers.push({ handler, delay, cleared: false });
    return armedTimers.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    const timer = armedTimers[id - 1];
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  cleanup();
  setSystemTime();
});

describe("useNativeWidgetSnapshotSync", () => {
  it("does not sync the pre-load [] fallback, then syncs once the list resolves", () => {
    const { rerender } = render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(syncedSnapshots).toHaveLength(0);

    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.conversations).toHaveLength(1);
  });

  it("a list that un-resolves after syncing does not blank the widgets", () => {
    const { rerender } = render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    // The query fell into a terminal error: the caller reports unresolved and
    // the list is the `[]` fallback again.
    rerender({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(clearCount).toBe(0);
  });

  it("clears the snapshot when the assistant changes before the new list resolves", () => {
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(clearCount).toBe(0);

    // The switch lands: the new assistant's list query starts over, so it is
    // the unresolved `[]` fallback again. The previous assistant's rows must
    // not survive it.
    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
    expect(syncedSnapshots).toHaveLength(1);

    // A second unresolved render of the same new assistant is not another
    // switch.
    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);

    // The new assistant's own list finally lands.
    rerender({
      assistantId: "asst-2",
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.conversations[0]?.id).toBe("c2");
  });

  it("writes the new assistant's snapshot without a clear when its list is already resolved", () => {
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    rerender({
      assistantId: "asst-2",
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(clearCount).toBe(0);
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.conversations[0]?.id).toBe("c2");
  });

  it("re-syncs identical data across an assistant switch", () => {
    // The dedup key is the serialized payload, so two assistants with the
    // same rows would collide. The switch drops the key with the snapshot.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    rerender({
      assistantId: "asst-2",
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(clearCount).toBe(1);
    expect(syncedSnapshots).toHaveLength(2);
  });

  it("does not clear on the launch transition into the first assistant", () => {
    // `activeAssistantId` resolves after the layout mounts, so the hook sees
    // one unresolved render before the id arrives. That is not a switch: the
    // App Group's last-known-good snapshot has to survive it.
    const { rerender } = render({
      assistantId: "asst-1",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(0);
    expect(syncedSnapshots).toHaveLength(0);
  });

  it("records the producing assistant with the snapshot it writes", () => {
    render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedAssistantIds).toEqual([ASSISTANT_ID]);
  });

  it("clears a cold-boot snapshot left by another assistant before any list resolves", () => {
    // The launch that motivates the persisted id: the App Group still holds
    // the previous run's snapshot, this run starts on a different assistant,
    // and nothing in memory knows the difference.
    persistedAssistantId = "asst-previous-run";
    const { rerender } = render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
    expect(syncedSnapshots).toHaveLength(0);

    // The producer is consulted once, so a list that stays unresolved does
    // not cost a clear per render.
    rerender({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
  });

  it("finishes a clear a previous session could not, before writing its own", () => {
    // The previous session's sign-out reached a bridge that rejected or never
    // answered, so its snapshot is still up and the obligation persisted. This
    // launch signs in as the same assistant, so nothing about the producer id
    // says anything is wrong: the obligation is the only thing that reaches it.
    pendingClear = true;
    persistedAssistantId = ASSISTANT_ID;
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(bridgeOrder).toEqual(["clear", "sync"]);
  });

  it("issues no clear on a launch that owes none", () => {
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(bridgeOrder).toEqual(["sync"]);
  });

  it("finishes an owed clear even on a launch whose list never resolves", () => {
    // Offline, or an assistant that never comes up: this session reaches no
    // sync and no switch, so the mount is the only seam the obligation has.
    pendingClear = true;
    persistedAssistantId = ASSISTANT_ID;
    render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
    expect(syncedSnapshots).toHaveLength(0);
  });

  it("keeps a cold-boot snapshot this assistant produced while its list is pending", () => {
    persistedAssistantId = ASSISTANT_ID;
    render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(0);
    expect(syncedSnapshots).toHaveLength(0);
  });

  it("clears when the assistant changes away from a cold-boot producer whose own list never resolved", () => {
    // The producer is read once per launch, so the owner it names has to be
    // retained rather than held for that render alone. Here the launch starts
    // on the recorded producer, so the read is not a switch and writes no
    // snapshot of its own; a switch away before the list resolves is still a
    // switch, and leaving it undetected would keep this assistant's titles on
    // the Home Screen for as long as the next one stayed unresolved.
    persistedAssistantId = ASSISTANT_ID;
    const { rerender } = render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(0);

    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
    expect(syncedSnapshots).toHaveLength(0);

    // Still one switch, however long the new assistant takes.
    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
  });

  it("waits for the active assistant before judging a cold-boot snapshot", () => {
    // `activeAssistantId` resolves after the layout mounts. A null id matches
    // nothing, so acting on it would blank the widgets on every launch.
    persistedAssistantId = "asst-previous-run";
    const { rerender } = render({
      assistantId: null,
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(0);

    rerender({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);
  });

  it("syncs the three most recent rows with group names, unseen and processing state", () => {
    useConversationStore.setState({
      processingConversationIds: new Set(["c-client-turn"]),
    });
    render({
      conversations: [
        conversation("c-old", {
          title: "Oldest",
          lastMessageAt: Date.parse("2026-07-01T00:00:00Z"),
        }),
        conversation("c-archived", {
          lastMessageAt: Date.parse("2026-08-05T00:00:00Z"),
          archivedAt: Date.parse("2026-08-05T00:00:00Z"),
        }),
        conversation("c-client-turn", {
          title: "Client turn",
          lastMessageAt: Date.parse("2026-08-04T00:00:00Z"),
        }),
        conversation("c-server-turn", {
          title: "Server turn",
          lastMessageAt: Date.parse("2026-08-03T00:00:00Z"),
          isProcessing: true,
          groupId: "g1",
        }),
        conversation("c-unseen", {
          title: undefined,
          lastMessageAt: Date.parse("2026-08-02T00:00:00Z"),
          hasUnseenLatestAssistantMessage: true,
          groupId: "g-missing",
        }),
      ],
      conversationGroups: [group("g1", "Errands")],
      inputsResolved: true,
    });

    expect(syncedSnapshots).toHaveLength(1);
    const snapshot = syncedSnapshots[0];
    expect(snapshot?.schemaVersion).toBe(2);
    expect(snapshot?.unreadCount).toBe(1);
    // Both processing sources count, and the archived row is excluded from
    // the count as well as from the rows.
    expect(snapshot?.inProgressCount).toBe(2);
    // Newest first, and no timestamp on a row: the order the widgets draw is
    // the order they are sent in, so nothing on the Swift side dates a row.
    expect(snapshot?.conversations).toEqual([
      {
        id: "c-client-turn",
        title: "Client turn",
        subtitle: undefined,
        hasUnseen: false,
        isProcessing: true,
      },
      {
        id: "c-server-turn",
        title: "Server turn",
        subtitle: "Errands",
        hasUnseen: false,
        isProcessing: true,
      },
      {
        id: "c-unseen",
        // The widget draws this string as sent, so the untitled fallback comes
        // from the chat catalog. Tests run pinned to English, so it reads as
        // the source copy here.
        title: "Untitled",
        subtitle: undefined,
        hasUnseen: true,
        isProcessing: false,
      },
    ]);
  });

  it("syncs an empty snapshot once an empty list resolves", () => {
    render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]).toMatchObject({
      unreadCount: 0,
      inProgressCount: 0,
      conversations: [],
    });
  });

  it("dedupes identical data across re-renders, ignoring the moving generatedAt", async () => {
    setSystemTime(new Date("2026-08-21T16:00:00Z"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.generatedAt).toBe("2026-08-21T16:00:00.000Z");
    await settle();

    // A later render of the same data would carry a different `generatedAt`.
    // The dedup key excludes it, so nothing reaches the bridge.
    setSystemTime(new Date("2026-08-21T16:05:00Z"));
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    // A real change still gets through.
    rerender({
      conversations: [conversation("c1", { title: "Groceries and dinner" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.generatedAt).toBe("2026-08-21T16:05:00.000Z");
  });

  it("retries a sync the bridge never landed", async () => {
    // An older shell rejects the call and one that never answers hits the
    // module's timeout; either way nothing reached the App Group. Arming the
    // dedup key there would leave the previous snapshot on the Home Screen
    // until the conversation data itself changed.
    syncLands = false;
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    await settle();

    syncLands = true;
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    await settle();

    // That one landed, so an identical render costs no bridge traffic.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedAssistantIds).toEqual([ASSISTANT_ID, ASSISTANT_ID]);
  });

  it("does not resend a payload the bridge is still holding", async () => {
    // The key is armed from the call's resolution, so the payload in flight is
    // deduped against separately: a re-render inside the bridge's window must
    // not cost a second write and a second widget timeline reload.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    await settle();
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("beats at half the window the widgets call a snapshot stale", () => {
    // `SnapshotProvider.staleAfter` in SnapshotTimeline.swift, which nothing
    // shares across the bridge. Half of it leaves room for a lost heartbeat.
    expect(WIDGET_SNAPSHOT_HEARTBEAT_MS).toBe(15 * 60 * 1000);
  });

  it("re-sends the current snapshot with a fresh generatedAt while the app is open", async () => {
    setSystemTime(new Date("2026-08-21T16:00:00Z"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    await settle();

    // Nothing about the conversations changed, so the content dedup would hold
    // this back. Only the timestamp is at stake.
    setSystemTime(new Date("2026-08-21T16:15:00Z"));
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.conversations).toEqual(
      syncedSnapshots[0]?.conversations ?? [],
    );
    expect(syncedSnapshots[1]?.generatedAt).toBe("2026-08-21T16:15:00.000Z");
    expect(syncedAssistantIds).toEqual([ASSISTANT_ID, ASSISTANT_ID]);
    await settle();

    // And the re-send did not disturb the dedup key it was built from.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
  });

  it("beats with the newest content after a sync the bridge never landed", async () => {
    // The App Group still holds the older payload while the session's current
    // data is the newer one, and settling a rejected call triggers no render,
    // so nothing else retries it. The tick is that retry.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    syncLands = false;
    rerender({
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    await settle();

    syncLands = true;
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(3);
    expect(syncedSnapshots[2]?.conversations[0]?.id).toBe("c2");
    await settle();

    // The retry landed, so the newer payload is the dedup key now and an
    // identical render costs no bridge traffic.
    rerender({
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(3);
  });

  it("never re-stamps the landed payload once newer content is wanted", async () => {
    // Re-sending the last landed payload would move `generatedAt` forward on
    // conversations and counts the session already knows are outdated, telling
    // the widgets they are current for as long as the writes keep failing.
    setSystemTime(new Date("2026-08-21T16:00:00Z"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    syncLands = false;
    rerender({
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    fireHeartbeat();
    await settle();
    fireHeartbeat();
    await settle();

    expect(
      syncedSnapshots.map((snapshot) => snapshot.conversations[0]?.id),
    ).toEqual(["c1", "c2", "c2", "c2"]);
  });

  it("does not heartbeat before anything is wanted", async () => {
    // An empty or signed-out session has no freshness to keep and nothing to
    // retry, so a tick that outlives the run which cleared it sends nothing.
    syncLands = false;
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    await settle();

    // Switching away clears what this assistant wanted, so the retry the tick
    // would otherwise carry cannot resurrect its rows under the new assistant.
    const beforeSwitch = liveHeartbeats()[0];
    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    beforeSwitch?.handler();
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("arms no heartbeat while the inputs are unresolved", async () => {
    // The heartbeat says the data is current, which a pending or errored query
    // cannot say: the preserved snapshot is left to age out natively instead.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(liveHeartbeats()).toHaveLength(1);

    rerender({
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(liveHeartbeats()).toHaveLength(0);

    // The same assistant's list comes back, and so does the heartbeat.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(1);
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("arms no heartbeat once the assistant stops being active", async () => {
    // The queries keep serving their cached rows with neither pending nor
    // error set, so resolution outlives the assistant and only the gate those
    // queries run under can say the data is still being kept current.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    const beforeInactive = liveHeartbeats()[0];

    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      isAssistantActive: false,
      inputsResolved: true,
    });
    expect(beforeInactive?.cleared).toBe(true);
    expect(liveHeartbeats()).toHaveLength(0);

    // The assistant comes back, and so does the freshness the widgets read.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(1);
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.conversations[0]?.id).toBe("c1");
  });

  it("arms no heartbeat once the pod stops serving", async () => {
    // The other half of the same gate: the assistant record stays active while
    // its pod is unreachable, and the cached rows stay resolved throughout.
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(liveHeartbeats()).toHaveLength(1);

    podIsServing = false;
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(0);

    podIsServing = true;
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(1);
  });

  it("drops the previous assistant's payload from the heartbeat on a switch", async () => {
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    const beforeSwitch = liveHeartbeats()[0];

    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(beforeSwitch?.cleared).toBe(true);
    expect(liveHeartbeats()).toHaveLength(0);

    // A tick the platform coalesced past the teardown must not put the
    // previous assistant's rows back on a Home Screen that was just cleared.
    beforeSwitch?.handler();
    expect(syncedSnapshots).toHaveLength(1);

    // The new assistant's own list lands, and the heartbeat carries it.
    rerender({
      assistantId: "asst-2",
      conversations: [conversation("c2", { title: "Flights" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(3);
    expect(syncedSnapshots[2]?.conversations[0]?.id).toBe("c2");
    expect(syncedAssistantIds[2]).toBe("asst-2");
  });

  it("leaves the bookkeeping intact when a heartbeat does not land", async () => {
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    syncLands = false;
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(2);
    await settle();

    // The failure changed nothing about what the App Group holds, so the dedup
    // key still describes it and identical data still costs no bridge traffic.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);

    // And the payload is still there to beat with on the next tick.
    syncLands = true;
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(3);
    expect(syncedSnapshots[2]?.conversations[0]?.id).toBe("c1");
  });

  it("skips a heartbeat while a real sync is on the bridge", () => {
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    // The first write has not settled: it is already carrying a fresh
    // timestamp, and racing it would retire the attempt it counts on.
    fireHeartbeat();
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("carries a character avatar's rendered accent and encoded face", async () => {
    setAvatar(characterAvatar("orange"));
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "character",
      accentHex: ORANGE_HEX,
      imageBase64: AVATAR_BASE64,
    });
  });

  it("carries the default character when the assistant has no traits", async () => {
    // The app draws a creature for an assistant that never opened the avatar
    // builder, off the first of each component. The widgets resolve through the
    // same helpers, so they draw that face and tint themselves to its color
    // rather than falling back to the brand mark and palette.
    setAvatar(defaultCharacterAvatar());
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "character",
      accentHex: GREEN_HEX,
      imageBase64: AVATAR_BASE64,
    });
  });

  it("carries a custom image with no accent to match", async () => {
    // The rendered accent is null for an uploaded avatar by construction, and
    // the widget blurs the photo for its background instead.
    setAvatar(imageAvatar("blob:avatar-1"));
    render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "image",
      accentHex: null,
      imageBase64: AVATAR_BASE64,
    });
  });

  it("carries an empty avatar when the assistant has none", () => {
    render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });

    // Nothing to encode, so the snapshot is not held for one either: the send
    // is synchronous with the render that fired it.
    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "none",
      accentHex: null,
      imageBase64: null,
    });
    expect(encodeCalls).toBe(0);
  });

  it("still sends the counts and rows when the avatar will not encode", async () => {
    // Both ways it can fail: nothing fit the budget, and the raster threw. The
    // widgets are for the counts and the rows, so neither may cost a snapshot.
    encodeOutcome = "nothing-fits";
    setAvatar(characterAvatar("orange"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "character",
      accentHex: ORANGE_HEX,
      imageBase64: null,
    });
    expect(syncedSnapshots[0]?.conversations).toHaveLength(1);

    encodeOutcome = "throws";
    setAvatar(characterAvatar("orange"));
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.avatar.imageBase64).toBeNull();
    expect(syncedSnapshots[1]?.conversations).toHaveLength(1);
  });

  it("holds the first sync until the avatar query settles", async () => {
    // The cold launch this closes: the avatar query routinely settles after the
    // conversation list, and the plugin replaces the App Group record whole, so
    // a first sync taken on the loading state would ship `kind: "none"`, wipe
    // the themed avatar the previous run left behind, and flash every widget to
    // the brand palette until a second sync repainted it.
    setAvatar(NO_AVATAR, true);
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(0);

    // Nothing about the conversations moves: the avatar arriving is the event.
    act(() => {
      publishAvatar(characterAvatar("orange"));
    });
    await settle();

    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.avatar).toEqual({
      kind: "character",
      accentHex: ORANGE_HEX,
      imageBase64: AVATAR_BASE64,
    });
    expect(syncedSnapshots[0]?.conversations).toHaveLength(1);

    // A later render of the same data is deduped, so the held sync cost nothing
    // beyond the wait.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("arms no heartbeat while the avatar query is still loading", () => {
    // The heartbeat asserts the snapshot is current, and a run that has not
    // sent one yet has no freshness to keep.
    setAvatar(NO_AVATAR, true);
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(0);

    act(() => {
      publishAvatar(characterAvatar("orange"));
    });
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(liveHeartbeats()).toHaveLength(1);
  });

  it("does not wait on an avatar query with no assistant to load one for", () => {
    // The query is gated off before an assistant resolves, so waiting on it
    // would hold every signed-out session's snapshot forever.
    setAvatar(NO_AVATAR, true);
    render({
      assistantId: null,
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedAssistantIds).toEqual([null]);
  });

  it("retries an avatar encode that threw rather than pinning the session", async () => {
    // A canvas the shell would not hand over, or a blob URL revoked mid-draw:
    // transient, and cached as `no avatar` it would strip the face off every
    // later snapshot in the run, heartbeats included. The avatar object is the
    // same across both renders, so only a dropped memo can produce a retry, and
    // the drop only happens if the failed draw rejects all the way out of the
    // ladder rather than being flattened into a null the memo would cache.
    encodeOutcome = "throws";
    const avatar = characterAvatar("orange");
    setAvatar(avatar);
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.avatar.imageBase64).toBeNull();

    encodeOutcome = "bytes";
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();

    expect(encodeCalls).toBe(2);
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.avatar).toEqual({
      kind: "character",
      accentHex: ORANGE_HEX,
      imageBase64: AVATAR_BASE64,
    });
  });

  it("retires a write still waiting on the draw when the hook unmounts", async () => {
    // Signing out clears the App Group and unmounts the layout while the
    // first avatar encode can still be on the canvas. The write that draw
    // eventually releases must not land: it would put the departed account's
    // titles and face back on a Home Screen the clear just emptied.
    encodeOutcome = "held";
    setAvatar(characterAvatar("orange"));
    const { unmount } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(0);
    expect(releaseHeldRasterize).not.toBeNull();

    unmount();
    releaseHeldRasterize?.(AVATAR_BYTES);
    await settle();

    expect(syncedSnapshots).toHaveLength(0);
  });

  it("keeps a write a plain unmount overtook once it was on the bridge", async () => {
    // The draw finished first, so the write is past the hook's own check and
    // inside the module when the layout unmounts. An unmount by itself is the
    // app closing or the layout swapping out, neither of which ends the
    // session, so what landed is exactly what the Home Screen should keep. The
    // hook records nothing for it either way: the attempt is retired, so its
    // own guard skips the bookkeeping.
    encodeOutcome = "held";
    setAvatar(characterAvatar("orange"));
    const { unmount } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(0);
    expect(releaseHeldRasterize).not.toBeNull();

    let openBridge = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openBridge = resolve;
    });
    releaseHeldRasterize?.(AVATAR_BYTES);
    await settle();
    expect(syncedSnapshots).toHaveLength(1);
    expect(bridgeOrder).toEqual(["sync"]);

    unmount();
    openBridge();
    await settle();

    expect(bridgeOrder).toEqual(["sync"]);
    expect(clearCount).toBe(0);
    expect(persistedAssistantId).toBe(ASSISTANT_ID);
  });

  it("clears a write a sign-out overtook once it was on the bridge", async () => {
    // The same window, with the seam that does end the session: sign-out clears
    // the App Group while the write is inside the module. Retiring the attempt
    // cannot recall it there, so the clear it raced is what the module corrects
    // against, leaving the Home Screen the sign-out emptied empty.
    encodeOutcome = "held";
    setAvatar(characterAvatar("orange"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(releaseHeldRasterize).not.toBeNull();

    let openBridge = (): void => {};
    syncGate = new Promise<void>((resolve) => {
      openBridge = resolve;
    });
    releaseHeldRasterize?.(AVATAR_BYTES);
    await settle();
    expect(bridgeOrder).toEqual(["sync"]);

    await endSessionClear();
    openBridge();
    await settle();

    expect(bridgeOrder).toEqual(["sync", "clear", "clear"]);
    expect(persistedAssistantId).toBeNull();

    // And nothing was recorded as landed for it, so the same rows are sent
    // again rather than deduped away against a snapshot that is no longer in
    // the App Group.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(2);
  });

  it("caches an avatar that legitimately encodes to nothing", async () => {
    // Nothing fitting any rung is a fact about the source, not a failure, so
    // it must not cost a canvas draw on every render that follows.
    encodeOutcome = "nothing-fits";
    setAvatar(characterAvatar("orange"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(encodeCalls).toBe(1);

    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(encodeCalls).toBe(1);
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("re-sends unchanged conversations when the avatar changes", async () => {
    // One photo swapped for another changes neither the kind nor the accent, so
    // only the identity the key carries can tell the snapshots apart.
    setAvatar(imageAvatar("blob:avatar-1"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(1);

    setAvatar(imageAvatar("blob:avatar-2"));
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(2);

    // And the same avatar with the same rows still costs no bridge traffic.
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    // Once per avatar, however many snapshots each one feeds.
    expect(encodeCalls).toBe(2);
  });

  it("drops a write the assistant switched out from under while it encoded", async () => {
    // The wait on the canvas draw is the one window in which a switch can
    // overtake a snapshot. Letting it land would put the departed assistant's
    // rows straight back on a Home Screen that was just cleared.
    setAvatar(characterAvatar("orange"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(0);

    rerender({
      assistantId: "asst-2",
      conversations: [],
      conversationGroups: NO_GROUPS,
      inputsResolved: false,
    });
    expect(clearCount).toBe(1);

    await settle();
    expect(syncedSnapshots).toHaveLength(0);
    expect(bridgeOrder).toEqual(["clear"]);
  });

  it("keeps the avatar's bytes out of the dedup key", async () => {
    setAvatar(characterAvatar("orange"));
    const serialized = recordSerialized(() => {
      const { rerender } = render({
        conversations: [conversation("c1", { title: "Groceries" })],
        conversationGroups: NO_GROUPS,
        inputsResolved: true,
      });
      rerender({
        conversations: [conversation("c1", { title: "Groceries" })],
        conversationGroups: NO_GROUPS,
        inputsResolved: true,
      });
    });
    await settle();

    // The key was built, and the multi-kilobyte body never went through it.
    expect(serialized.some((entry) => entry.includes('"unreadCount"'))).toBe(
      true,
    );
    expect(serialized.some((entry) => entry.includes(AVATAR_BASE64))).toBe(
      false,
    );
    // The bytes still reached the bridge.
    expect(syncedSnapshots[0]?.avatar.imageBase64).toBe(AVATAR_BASE64);
  });

  it("syncs an avatar that changed while nothing else did", async () => {
    // The gap this closes: `RootLayout` publishes its avatar copies from a
    // PARENT effect, and React runs a child's effects first, so a snapshot
    // built from those would be a render behind whenever the avatar and the
    // conversation data move in one commit. An in-SPA assistant switch into an
    // already-cached destination is that commit, and the dedup key would then
    // pin the previous assistant's face until the heartbeat. Reading the avatar
    // reactively is what makes the change its own trigger.
    setAvatar(characterAvatar("orange"));
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.avatar.accentHex).toBe(ORANGE_HEX);

    // Nothing about the conversation list moves and nothing re-renders the
    // layout of its own accord: the avatar arriving is the whole event.
    act(() => {
      publishAvatar(characterAvatar("teal"));
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.avatar).toEqual({
      kind: "character",
      accentHex: TEAL_HEX,
      imageBase64: AVATAR_BASE64,
    });
    expect(syncedSnapshots[1]?.conversations).toEqual(
      syncedSnapshots[0]?.conversations ?? [],
    );
    // And it got there without the heartbeat, which is still armed and unfired.
    expect(liveHeartbeats()).toHaveLength(1);
  });

  it("beats with the avatar the session currently has", async () => {
    // The tick shares the send path, so it carries whatever the avatar is now
    // rather than what the last data sync happened to encode.
    setAvatar(characterAvatar("orange"));
    render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(1);

    act(() => {
      publishAvatar(imageAvatar("blob:avatar-1"));
    });
    await settle();
    expect(syncedSnapshots).toHaveLength(2);

    fireHeartbeat();
    await settle();
    expect(syncedSnapshots).toHaveLength(3);
    expect(syncedSnapshots[2]?.avatar).toEqual({
      kind: "image",
      accentHex: null,
      imageBase64: AVATAR_BASE64,
    });
    expect(syncedSnapshots[2]?.conversations).toEqual(
      syncedSnapshots[0]?.conversations ?? [],
    );
  });

  it("is a no-op off Capacitor iOS", () => {
    syncAvailable = false;
    // Including the obligation: nothing off iOS ever wrote a snapshot, so
    // there is none to owe a clear for.
    pendingClear = true;
    render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      inputsResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(0);
    expect(bridgeOrder).toHaveLength(0);
  });
});

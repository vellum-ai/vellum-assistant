/**
 * Fixtures and the shared harness for the Chat Info suites: the two daemon
 * summaries the panel lists, the assets it renders as tiles, the transcript
 * rows and the daemon attachment listing those assets come from, the query
 * client its hooks read, the assistant version its listing gate reads, the
 * modules a suite hands `mock.module`, and the browser APIs happy-dom leaves
 * out.
 *
 * Every asset goes through `toConversationFileAssets`, the mapping the hook
 * itself runs, so a fixture cannot drift from the ids and shapes the panel
 * receives in the app.
 *
 * Kept free of any test-runner import so `chat-info-story-fixtures.tsx` can
 * build on it, the way `utils/conversation-list.test-helper.ts` already is. A
 * `mock.module` call is process-global, so it stays in the suite; only the
 * module body it installs lives here.
 */

import { QueryClient } from "@tanstack/react-query";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-attachment-list";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import {
  type ConversationFileAsset,
  toConversationFileAssets,
} from "@/domains/chat/hooks/use-conversation-assets";
import {
  type ConversationAttachmentEntry,
  conversationAttachmentListArgs,
  type SightFrameFilter,
} from "@/domains/chat/hooks/use-conversation-attachments";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  appsGetQueryKey,
  attachmentsGetInfiniteQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type * as ElementSizeModule from "@/hooks/use-element-size";
import { makeAppSummary as makeSharedAppSummary } from "@/types/app-summary.test-helper";
import type { AppSummary } from "@/types/app-types";
import type {
  ConversationAttachmentSummary,
  DisplayAttachment,
} from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";
import * as appHtmlCache from "@/utils/app-html-cache";

/** Fixed epoch ms, so nothing built here depends on the clock. */
export const CHAT_INFO_T0 = 1_760_000_000_000;

/** The drawer body's column on the desktop mock: 3 app tiles, 4 file tiles. */
export const CHAT_INFO_DRAWER_WIDTH_PX = 569;

/**
 * The narrowest phone the app's designs are drawn for, screen width and all.
 * `sbCompactPhone` is the Storybook viewport at the same width.
 */
export const CHAT_INFO_NARROW_PHONE_PX = 402;

/**
 * The locale a suite pins both of the axes a formatter resolves to: i18next's
 * active language, and the host language `formatLocale()` prefers over it when
 * the two share a primary language. Pin the host one with `stubHostLanguage`.
 */
export const CHAT_INFO_TEST_LOCALE = "en";

/** The shared app builder, under the defaults every Chat Info fixture wants. */
export function makeAppSummary(
  overrides: Partial<AppSummary> = {},
): AppSummary {
  return makeSharedAppSummary({
    id: "app-1",
    icon: "🧭",
    createdAt: CHAT_INFO_T0,
    updatedAt: CHAT_INFO_T0,
    ...overrides,
  });
}

/** A daemon document summary with every field defaulted, `overrides` on top. */
export function makeDocumentSummary(
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  const surfaceId = overrides.surfaceId ?? "surface-1";
  return {
    surfaceId,
    conversationId: "conv-1",
    title: "Trip Notes",
    wordCount: 120,
    createdAt: CHAT_INFO_T0,
    updatedAt: CHAT_INFO_T0,
    ...overrides,
  };
}

/**
 * One attachment entry as the transcript path produces it. The key is the
 * attachment's own id, which is what the hook uses for anything but a legacy
 * `rehydrated:N` row.
 */
function makeAttachmentEntry(
  attachment: DisplayAttachment,
  overrides: Partial<Omit<ConversationAttachmentEntry, "attachment">> = {},
): ConversationAttachmentEntry {
  return {
    key: attachment.id,
    attachment,
    capturedAt: null,
    sightFrame: false,
    ...overrides,
  };
}

/** One document as the file asset the panel hands a tile. */
export function makeDocumentAsset(doc: DocumentSummary): ConversationFileAsset {
  return toConversationFileAssets([doc], []).files[0]!;
}

/** One attachment as the file asset the panel hands a tile. */
export function makeFileAsset(
  attachment: DisplayAttachment,
): ConversationFileAsset {
  return toConversationFileAssets([], [makeAttachmentEntry(attachment)])
    .files[0]!;
}

/** One attachment as the camera-frame asset the panel hands a tile. */
export function makeFrameAsset(
  attachment: DisplayAttachment,
  capturedAt: number | null,
): ConversationFileAsset {
  return toConversationFileAssets(
    [],
    [makeAttachmentEntry(attachment, { sightFrame: true, capturedAt })],
  ).frames[0]!;
}

/** One transcript row, carrying only the fields a Chat Info fixture sets. */
export function makeTranscriptRow(
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id: "msg-1", role: "user", ...overrides };
}

/**
 * One row per attachment, oldest first from {@link CHAT_INFO_T0}. This is the
 * source `useConversationAttachments` walks, so the panel lists exactly these
 * files, newest first.
 */
export function attachmentRows(
  attachments: DisplayAttachment[],
): DisplayMessage[] {
  return attachments.map((attachment, index) =>
    makeTranscriptRow({
      id: `msg-${index + 1}`,
      timestamp: CHAT_INFO_T0 + index * 1_000,
      attachments: [attachment],
    }),
  );
}

/**
 * Names the conversation the seeded chat-session snapshot belongs to, which is
 * what `useConversationAttachments` gates on.
 */
function seedTranscriptOwner(
  assistantId: string,
  conversationId: string,
): void {
  useChatSessionStore.setState({
    previousAssistantId: assistantId,
    previousConversationId: conversationId,
  });
}

/** Unnames the owner, so a seeded transcript cannot outlive its test or story. */
export function clearTranscriptOwner(): void {
  useChatSessionStore.setState({
    previousAssistantId: null,
    previousConversationId: null,
  });
}

/**
 * The object URL every Chat Info stub hands back, so a test can assert an
 * image is drawing fetched bytes rather than an inline preview.
 */
export const CHAT_INFO_OBJECT_URL = "blob:chat-info";

/**
 * The two browser APIs the tiles need and happy-dom does not implement: object
 * URLs, and an IntersectionObserver that reports every observed tile on screen
 * straight away so the lazy image fetch runs inside the test.
 *
 * Returns a restore fn the caller invokes once done: a suite that leaves the
 * stubs installed hands them to whatever the runner evaluates next, and
 * `use-in-view.test.tsx` captures its `IntersectionObserver` at module scope.
 */
export function installChatInfoDomStubs(): () => void {
  const createObjectURL = globalThis.URL.createObjectURL;
  const revokeObjectURL = globalThis.URL.revokeObjectURL;
  const intersectionObserver = globalThis.IntersectionObserver;

  globalThis.URL.createObjectURL = () => CHAT_INFO_OBJECT_URL;
  globalThis.URL.revokeObjectURL = () => {};

  class ImmediateIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: number[] = [];
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;

  return () => {
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;
    globalThis.IntersectionObserver = intersectionObserver;
  };
}

/**
 * The `@/utils/app-html-cache` module body a suite installs, so an app tile's
 * live preview settles instead of calling the daemon's open endpoint.
 */
export function chatInfoAppHtmlCacheMock(): Partial<typeof appHtmlCache> {
  return {
    ...appHtmlCache,
    getCachedAppHtml: async () => "<!doctype html><title>App</title>",
  };
}

/**
 * The `@/hooks/use-element-size` module body a suite installs: happy-dom
 * reports a zero box for everything, so the row's width is read from here.
 */
export function makeElementSizeMock(
  readWidth: () => number,
): Partial<typeof ElementSizeModule> {
  return {
    useElementSize: () => ({ ref: () => {}, size: { w: readWidth(), h: 0 } }),
  };
}

/**
 * Seeded entries answer every read: `staleTime: Infinity` keeps them fresh so
 * nothing reaches the generated SDK, `retryOnMount: false` keeps a seeded
 * failure failed, and nothing is collected, so a test can seed before it
 * renders.
 */
const CHAT_INFO_QUERY_DEFAULTS = {
  retry: false,
  retryOnMount: false,
  gcTime: Infinity,
  staleTime: Infinity,
} as const;

/**
 * Holds the `Vellum-Organization-Id` header unresolved: a platform session with
 * no organization id yet. That is the gate the panel's two daemon queries wait
 * on, so a source a caller leaves unseeded stays unresolved with nothing
 * requested. Returns the restore fn.
 */
export function holdOrgHeaderUnresolved(): () => void {
  const { platformSession } = useAuthStore.getState();
  const { status, currentOrganizationId, persistedOrganizationId } =
    useOrganizationStore.getState();
  useAuthStore.setState({ platformSession: "present" });
  useOrganizationStore.setState({
    status: "loading",
    currentOrganizationId: null,
    persistedOrganizationId: null,
  });
  return () => {
    useAuthStore.setState({ platformSession });
    useOrganizationStore.setState({
      status,
      currentOrganizationId,
      persistedOrganizationId,
    });
  };
}

/** A client that serves what a test seeds and asks the daemon for nothing. */
export function makeChatInfoQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { ...CHAT_INFO_QUERY_DEFAULTS } },
  });
}

/** A client whose queries never run, so an unseeded source stays unresolved. */
export function makePendingChatInfoQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...CHAT_INFO_QUERY_DEFAULTS, enabled: false },
    },
  });
}

/** Puts one query into the state a failed fetch leaves behind. */
export function seedQueryFailure(
  client: QueryClient,
  queryKey: readonly unknown[],
  message = "assistant unreachable",
): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({
      status: "error",
      error: new Error(message),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
}

/** The apps and documents the daemon would list for one conversation. */
export function seedChatInfoConversation(
  client: QueryClient,
  {
    assistantId,
    conversationId,
    apps = [],
    documents = [],
  }: {
    assistantId: string;
    conversationId: string;
    apps?: AppSummary[];
    documents?: DocumentSummary[];
  },
): void {
  const path = { assistant_id: assistantId };
  client.setQueryData(appsGetQueryKey({ path, query: { conversationId } }), {
    apps,
  });
  // The app options menu reads the unscoped list to know whether a pin exists.
  client.setQueryData(appsGetQueryKey({ path }), { apps });
  client.setQueryData(
    documentsGetQueryKey({ path, query: { conversationId } }),
    { documents },
  );
}

/**
 * Reports `version` as the connected assistant's, which is the gate the daemon
 * attachment listing is read behind. Defaults to the version that opens it.
 * Returns the restore fn, so one test or story cannot leak a version into the
 * next.
 */
export function reportAssistantVersion(version = MIN_VERSION): () => void {
  const previous = useAssistantIdentityStore.getState();
  const { setIdentity } = previous;
  setIdentity(previous.name, version, previous.assistantId);
  return () => {
    setIdentity(previous.name, previous.version, previous.assistantId);
  };
}

/** One row of the daemon's attachment listing, defaults under `overrides`. */
export function makeAttachmentSummary(
  overrides: Partial<ConversationAttachmentSummary> = {},
): ConversationAttachmentSummary {
  const id = overrides.id ?? "att-1";
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1_024,
    kind: "image",
    messageId: "msg-1",
    createdAt: CHAT_INFO_T0,
    sightFrame: false,
    ambientKeep: false,
    ...overrides,
  };
}

/**
 * One answered page of the daemon's attachment listing, under the key the hook
 * reads it back from, so a seed and the hook cannot land on different keys.
 * `total` defaults to the rows given, which is a listing with nothing beyond
 * them; a larger one is what the second level's Load more control appears for.
 */
export function seedAttachmentList(
  client: QueryClient,
  {
    assistantId,
    conversationId,
    sightFrames,
    attachments,
    total = attachments.length,
  }: {
    assistantId: string;
    conversationId: string;
    sightFrames: SightFrameFilter;
    attachments: ConversationAttachmentSummary[];
    total?: number;
  },
): void {
  client.setQueryData(
    attachmentsGetInfiniteQueryKey(
      conversationAttachmentListArgs(assistantId, conversationId, sightFrames),
    ),
    {
      pages: [{ attachments, total, hasMore: total > attachments.length }],
      pageParams: [0],
    },
  );
}

/** Installs `messages` as the loaded transcript, under its owner. */
export function seedTranscriptMessages(
  assistantId: string,
  conversationId: string,
  messages: DisplayMessage[],
): void {
  // A seeded transcript has nothing in flight; the seed itself only prunes
  // the sends its messages confirm.
  useChatSessionStore.setState({ optimisticSends: [] });
  useChatSessionStore.getState().seedSnapshot(conversationId, {
    messages,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    seq: 1,
  });
  seedTranscriptOwner(assistantId, conversationId);
}

/** Drops the seeded transcript, so one test cannot leak into the next. */
export function clearTranscriptMessages(): void {
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  clearTranscriptOwner();
}

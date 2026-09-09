/**
 * Everything the Chat Info stories are built from: the asset sets they show,
 * the client that answers their queries, the seeded-conversation decorator, and
 * the two page frames the rows are read inside.
 *
 * The panel reads its assets through the real hooks, so a story has to fill the
 * sources those hooks go to: the query cache holds the conversation's apps and
 * documents, and the chat-session store holds the transcript the attachments
 * are derived from. {@link inChatInfoConversation} fills both, on a client of
 * the story's own, before the story's first paint.
 *
 * A conversation asking for {@link ChatInfoDaemonListing} fills a third source
 * and reports a version the listing gate opens on, so the panel takes its
 * daemon path: exact totals, a populated Camera Frames category, and the tiles
 * fetching their bytes under the shared attachment-content key.
 *
 * A story declares its conversation through `parameters.chatInfo` rather than
 * by wrapping itself in a second decorator, so the panel, the mobile overlay,
 * and the chat header each mount exactly one seeded conversation.
 */

import type { Decorator } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import {
  makeDisplayAttachment,
  makePreviewableImages,
  makeSamplePreview,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { attachmentContentQueryKey } from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import {
  attachmentRows,
  CHAT_INFO_DRAWER_WIDTH_PX,
  CHAT_INFO_NARROW_PHONE_PX,
  CHAT_INFO_T0,
  clearTranscriptMessages,
  holdOrgHeaderUnresolved,
  makeAppSummary,
  makeAttachmentSummary,
  makeChatInfoQueryClient,
  makeDocumentAsset,
  makeDocumentSummary,
  makeFileAsset,
  makeFrameAsset,
  makePendingChatInfoQueryClient,
  reportAssistantVersion,
  seedAttachmentList,
  seedChatInfoConversation,
  seedQueryFailure,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import { documentsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import type { ConversationAttachmentSummary } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { decodeBase64Payload } from "@/utils/base64";

export const CHAT_INFO_ASSISTANT_ID = "story-assistant";
export const CHAT_INFO_CONVERSATION_ID = "story-conversation";

/** Metadata only: the tile has to fetch these bytes before it can draw them. */
const STORY_LAZY_ATTACHMENT = makeDisplayAttachment({
  id: "ferry-deck",
  filename: "ferry-deck.png",
  sizeBytes: 190_464,
});

/**
 * The files the Chat Info stories are shown against: two daemon documents, an
 * image the transcript carries inline, one whose bytes the tile fetches, and a
 * PDF. `Object.values` gives the set as one category's items.
 */
export const CHAT_INFO_STORY_FILES = {
  tripNotes: makeDocumentAsset(
    makeDocumentSummary({
      surfaceId: "surface-trip-notes",
      title: "Trip Notes",
      wordCount: 842,
    }),
  ),
  packingList: makeDocumentAsset(
    makeDocumentSummary({
      surfaceId: "surface-packing-list",
      title: "Packing List",
      wordCount: 214,
    }),
  ),
  inlineImage: makeFileAsset(
    makeDisplayAttachment({
      id: "harbour-at-dawn",
      filename: "harbour-at-dawn.png",
      sizeBytes: 184_320,
      previewUrl: makeSamplePreview(240, 150),
    }),
  ),
  lazyImage: makeFileAsset(STORY_LAZY_ATTACHMENT),
  pdf: makeFileAsset(
    makeDisplayAttachment({
      id: "coast-guide",
      filename: "coast-guide.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2_097_152,
    }),
  ),
};

/**
 * One Live session as the daemon lists it: `count` captures three minutes
 * apart, newest first, metadata only. The bytes live behind the content
 * endpoint, so a tile draws a picture only for a frame a story seeds.
 */
function chatInfoFrameSummaries(
  count: number,
): ConversationAttachmentSummary[] {
  return Array.from({ length: count }, (_, index) =>
    makeAttachmentSummary({
      id: `camera-frame-${index + 1}`,
      filename: `camera-frame-${index + 1}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 98_304 + index * 2_048,
      messageId: `msg-camera-frame-${index + 1}`,
      createdAt: CHAT_INFO_T0 - index * 180_000,
      sightFrame: true,
    }),
  );
}

/** The same session as the assets a presentational story renders directly. */
export function chatInfoStoryFrames(count: number): ConversationFileAsset[] {
  return chatInfoFrameSummaries(count).map((summary, index) =>
    makeFrameAsset(
      makeDisplayAttachment({
        id: summary.id,
        filename: summary.filename,
        mimeType: summary.mimeType,
        sizeBytes: summary.sizeBytes,
        previewUrl: SAMPLE_PREVIEWS[index % SAMPLE_PREVIEWS.length]!,
      }),
      summary.createdAt,
    ),
  );
}

function makeSeededChatInfoStoryClient(assistantId: string): QueryClient {
  const client = makeChatInfoQueryClient();
  client.setQueryData(
    attachmentContentQueryKey(assistantId, STORY_LAZY_ATTACHMENT.id),
    new Blob([decodeBase64Payload(SAMPLE_PREVIEWS[2]!)!], {
      type: "image/png",
    }),
  );
  return client;
}

/**
 * The client the tile, row, and grid stories read. It holds the bytes the
 * daemon would return for the one story file with no inline preview, under the
 * same key the preview modal fetches with, so that tile draws the fetched path
 * with no daemon behind it.
 */
export const CHAT_INFO_STORY_CLIENT = makeSeededChatInfoStoryClient(
  CHAT_INFO_ASSISTANT_ID,
);

/** Serves every query from `client`, so no story reaches the daemon. */
export function withChatInfoStoryClient(client: QueryClient): Decorator {
  return function WithChatInfoStoryClient(Story) {
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}

/** The drawer body's column on the desktop mock, inside `DetailShell`'s lift surface and body inset. */
export const inChatInfoDrawerColumn: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{ padding: DETAIL_SHELL_BODY_INSET_PX }}
  >
    <div style={{ width: CHAT_INFO_DRAWER_WIDTH_PX }}>
      <Story />
    </div>
  </div>
);

/**
 * A phone page at the shell's body inset, which the strip's negative margin
 * cancels so the tiles run to the screen edge and the last one is cut off, as
 * in the mobile mock. Read it at the `sbCompactPhone` viewport, the width this
 * page is drawn for.
 */
export const inChatInfoPhonePage: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{
      maxWidth: CHAT_INFO_NARROW_PHONE_PX,
      padding: DETAIL_SHELL_BODY_INSET_PX,
    }}
  >
    <Story />
  </div>
);

/** Name, icon, and preview lines for each app a story can ask for. */
const APP_SEEDS: Array<{ name: string; icon: string; lines: string[] }> = [
  {
    name: "Trip Planner",
    icon: "🧭",
    lines: ["Book the ferry", "Pack a rain shell", "Confirm the tour"],
  },
  {
    name: "Packing List",
    icon: "🧳",
    lines: ["Rain shell", "Walking boots", "Ferry tickets"],
  },
  {
    name: "Ferry Times",
    icon: "⛴️",
    lines: ["07:40 harbour", "11:15 harbour", "16:50 harbour"],
  },
  {
    name: "Harbour Map",
    icon: "🗺️",
    lines: ["Pier 3 departures", "Long stay parking", "Ticket office"],
  },
  {
    name: "Tide Table",
    icon: "🌊",
    lines: ["High 06:12", "Low 12:38", "High 18:47"],
  },
  {
    name: "Weather Watch",
    icon: "🌦️",
    lines: ["Showers by noon", "Gusts 24 knots", "Clearing overnight"],
  },
  {
    name: "Budget Tracker",
    icon: "💷",
    lines: ["Ferry 42", "Guesthouse 118", "Meals 64"],
  },
  {
    name: "Coastal Walks",
    icon: "🥾",
    lines: ["Cliff loop 6km", "Lighthouse 9km", "Dune path 3km"],
  },
  {
    name: "Bird Log",
    icon: "🐦",
    lines: ["Guillemot", "Fulmar", "Oystercatcher"],
  },
  {
    name: "Photo Picks",
    icon: "📷",
    lines: ["Dawn harbour", "Ferry deck", "Cliff path"],
  },
  {
    name: "Reading List",
    icon: "📚",
    lines: ["Island histories", "Tidal atlas", "Seabird guide"],
  },
  {
    name: "Field Notes",
    icon: "📓",
    lines: ["Wind picked up", "Colony nesting", "Fog off the point"],
  },
];

/** A small page for the preview iframe, in system colours so it reads in either theme. */
function chatInfoPreviewHtml(title: string, lines: string[]): string {
  const items = lines.map((line) => `<li>${line}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}h1{margin:0 0 12px;font-size:28px}ul{margin:0;padding-left:22px;font-size:18px;line-height:1.7}</style><h1>${title}</h1><ul>${items}</ul>`;
}

/** The first `count` fixture apps, newest first. */
export function chatInfoApps(count: number): AppSummary[] {
  return APP_SEEDS.slice(0, count).map((seed, index) =>
    makeAppSummary({
      id: `app-${index + 1}`,
      name: seed.name,
      icon: seed.icon,
      updatedAt: CHAT_INFO_T0 + (count - index) * 1_000,
      contentId: `content-${index + 1}`,
    }),
  );
}

const DOCUMENT_TITLES = [
  "Trip Notes",
  "Harbour Itinerary",
  "Ferry Booking Summary",
];

/** The first `count` fixture documents, newest first. */
function chatInfoDocuments(
  count: number,
  conversationId: string,
): DocumentSummary[] {
  return DOCUMENT_TITLES.slice(0, count).map((title, index) =>
    makeDocumentSummary({
      surfaceId: `surface-${index + 1}`,
      conversationId,
      title,
      wordCount: 320 + index * 140,
      updatedAt: CHAT_INFO_T0 + (count - index) * 1_000,
    }),
  );
}

/** How many camera frames the daemon's listing answers with, and holds. */
export interface ChatInfoDaemonListing {
  /** Frame rows the camera-frames list returns. */
  frameCount: number;
  /** The category's exact total, which the rows returned need not reach. */
  frameTotal: number;
}

/** Frames whose bytes a story seeds; the rest fall back to the file glyph. */
const FRAMES_WITH_BYTES = 4;

/**
 * The bytes the daemon would return for one attachment, under the key every
 * tile fetches with. Anything but a base64 data URI is left unseeded, so that
 * tile draws its glyph.
 */
function seedAttachmentBytes(
  client: QueryClient,
  assistantId: string,
  attachmentId: string,
  source: string,
): void {
  const bytes = decodeBase64Payload(source);
  if (!bytes) {
    return;
  }
  client.setQueryData(
    attachmentContentQueryKey(assistantId, attachmentId),
    new Blob([bytes], { type: "image/png" }),
  );
}

/** The conversation's own files as the daemon lists them, frames left out. */
function chatInfoFileSummaries(
  attachments: DisplayAttachment[],
): ConversationAttachmentSummary[] {
  return attachments.map((attachment, index) =>
    makeAttachmentSummary({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      messageId: `msg-${index + 1}`,
      createdAt: CHAT_INFO_T0 + index * 1_000,
    }),
  );
}

/** The conversation a story asks for through `parameters.chatInfo`. */
export interface ChatInfoStoryConversation {
  assistantId: string;
  conversationId: string;
  appCount: number;
  documentCount: number;
  attachments: DisplayAttachment[];
  /** Leaves both daemon queries unresolved, on a client whose queries never run. */
  pendingSources?: boolean;
  /** Answers the panel from the daemon's attachment listing, gate opened. */
  daemonListing?: ChatInfoDaemonListing;
  /** Runs on the seeded client, to leave one source in a state the daemon would. */
  afterSeed?: (
    client: QueryClient,
    conversation: ChatInfoStoryConversation,
  ) => void;
}

/** An `afterSeed` that leaves the documents source failed with nothing cached. */
export function failChatInfoDocuments(
  client: QueryClient,
  { assistantId, conversationId }: ChatInfoStoryConversation,
): void {
  const queryKey = documentsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { conversationId },
  });
  client.removeQueries({ queryKey });
  seedQueryFailure(client, queryKey);
}

/** A worked-in trip conversation, the set most stories are shown against. */
const DEFAULT_CONVERSATION: ChatInfoStoryConversation = {
  assistantId: CHAT_INFO_ASSISTANT_ID,
  conversationId: CHAT_INFO_CONVERSATION_ID,
  appCount: 12,
  documentCount: 2,
  attachments: makePreviewableImages(2),
};

/**
 * Primes each app's html so its tile renders a live preview instead of the
 * icon placeholder, on the fixture lines the app's position carries.
 */
export function primeChatInfoAppPreviews(
  assistantId: string,
  apps: AppSummary[],
): void {
  for (const [index, app] of apps.entries()) {
    const seed = APP_SEEDS[index % APP_SEEDS.length]!;
    primeAppHtmlCache(
      assistantId,
      app.id,
      chatInfoPreviewHtml(app.name, seed.lines),
    );
  }
}

/** Fills the query cache the way the daemon would, previews included. */
function seedChatInfoQueries(
  client: QueryClient,
  {
    assistantId,
    conversationId,
    appCount,
    documentCount,
  }: ChatInfoStoryConversation,
): void {
  const apps = chatInfoApps(appCount);
  seedChatInfoConversation(client, {
    assistantId,
    conversationId,
    apps,
    documents: chatInfoDocuments(documentCount, conversationId),
  });
  primeChatInfoAppPreviews(assistantId, apps);
}

/**
 * Fills the two list reads the daemon path takes, and the bytes behind the
 * tiles that draw a picture: the conversation's own files, and one Live
 * session's frames.
 */
function seedChatInfoDaemonListing(
  client: QueryClient,
  { assistantId, conversationId, attachments }: ChatInfoStoryConversation,
  { frameCount, frameTotal }: ChatInfoDaemonListing,
): void {
  seedAttachmentList(client, {
    assistantId,
    conversationId,
    sightFrames: "exclude",
    attachments: chatInfoFileSummaries(attachments),
  });
  for (const attachment of attachments) {
    seedAttachmentBytes(
      client,
      assistantId,
      attachment.id,
      attachment.previewUrl ?? "",
    );
  }

  const frames = chatInfoFrameSummaries(frameCount);
  seedAttachmentList(client, {
    assistantId,
    conversationId,
    sightFrames: "only",
    attachments: frames,
    total: frameTotal,
  });
  for (const [index, frame] of frames.slice(0, FRAMES_WITH_BYTES).entries()) {
    seedAttachmentBytes(
      client,
      assistantId,
      frame.id,
      SAMPLE_PREVIEWS[index % SAMPLE_PREVIEWS.length]!,
    );
  }
}

/** Installs the story's attachments as the rendered transcript, under its owner. */
function seedChatInfoTranscript({
  assistantId,
  conversationId,
  attachments,
}: ChatInfoStoryConversation): void {
  seedTranscriptMessages(
    assistantId,
    conversationId,
    attachmentRows(attachments),
  );
}

/**
 * Seeds the two sources the panel's hooks read, on a client of this story's
 * own so one story's conversation cannot leak into the next through the
 * preview's shared one.
 *
 * The seed runs in a `useState` initializer, which React calls during this
 * decorator's own render, so the rows are in place for the story's first
 * paint rather than one commit later.
 */
export const inChatInfoConversation: Decorator =
  function InChatInfoConversation(Story, { parameters }) {
    const [{ client, restoreStores }] = useState(() => {
      const conversation: ChatInfoStoryConversation = {
        ...DEFAULT_CONVERSATION,
        ...(parameters.chatInfo as
          | Partial<ChatInfoStoryConversation>
          | undefined),
      };
      let created: QueryClient;
      const restores: Array<() => void> = [];
      if (conversation.pendingSources) {
        created = makePendingChatInfoQueryClient();
        // The org header is the gate the daemon queries wait on, so an
        // unresolved one is what leaves this story's sources unanswered.
        restores.push(holdOrgHeaderUnresolved());
      } else {
        created = makeChatInfoQueryClient();
        seedChatInfoQueries(created, conversation);
        if (conversation.daemonListing) {
          seedChatInfoDaemonListing(
            created,
            conversation,
            conversation.daemonListing,
          );
          restores.push(reportAssistantVersion());
        }
      }
      conversation.afterSeed?.(created, conversation);
      seedChatInfoTranscript(conversation);
      return {
        client: created,
        restoreStores: () => {
          for (const restore of restores) {
            restore();
          }
        },
      };
    });
    useEffect(() => {
      return () => {
        clearTranscriptMessages();
        restoreStores();
      };
    }, [restoreStores]);

    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };

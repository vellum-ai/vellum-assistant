/**
 * Fixtures and the seeded-conversation decorator for the Chat Info stories.
 *
 * The panel reads its assets through the real hooks, so a story has to fill
 * the two sources those hooks go to: the query cache holds the conversation's
 * apps and documents, and the chat-session store holds the transcript the
 * attachments are derived from. {@link inChatInfoConversation} fills both, on a
 * client of the story's own, before the story's first paint.
 *
 * A story declares its conversation through `parameters.chatInfo` rather than
 * by wrapping itself in a second decorator, so the panel, the mobile overlay,
 * and the chat header each mount exactly one seeded conversation.
 */

import type { Decorator } from "@storybook/react-vite";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { makePreviewableImages } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  attachmentRows,
  CHAT_INFO_T0,
  clearTranscriptMessages,
  makeAppSummary,
  makeChatInfoQueryClient,
  makeDocumentSummary,
  seedChatInfoConversation,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { primeAppHtmlCache } from "@/utils/app-html-cache";

export const CHAT_INFO_ASSISTANT_ID = "story-assistant";
export const CHAT_INFO_CONVERSATION_ID = "story-conversation";

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
export function chatInfoPreviewHtml(title: string, lines: string[]): string {
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

/** The conversation a story asks for through `parameters.chatInfo`. */
export interface ChatInfoStoryConversation {
  assistantId: string;
  conversationId: string;
  appCount: number;
  documentCount: number;
  attachments: DisplayAttachment[];
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
    const [client] = useState(() => {
      const conversation: ChatInfoStoryConversation = {
        ...DEFAULT_CONVERSATION,
        ...(parameters.chatInfo as
          | Partial<ChatInfoStoryConversation>
          | undefined),
      };
      const created = makeChatInfoQueryClient();
      seedChatInfoQueries(created, conversation);
      seedChatInfoTranscript(conversation);
      return created;
    });
    useEffect(() => clearTranscriptMessages, []);

    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };

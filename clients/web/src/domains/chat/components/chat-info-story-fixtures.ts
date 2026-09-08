/**
 * Fixtures for the Chat Info stories.
 *
 * The panel reads its assets through the real hooks, so a story has to fill
 * the two sources those hooks go to: the query cache holds the conversation's
 * apps and documents, and the chat-session store holds the transcript the
 * attachments are derived from. Everything here seeds one of those, so the
 * panel story and the mobile-overlay story can show the same conversation.
 *
 * No JSX and no test-runner import: this is data plus the calls that install
 * it, and the decorators that use it live in the story files.
 */

import type { QueryClient } from "@tanstack/react-query";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import {
  appsGetQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { primeAppHtmlCache } from "@/utils/app-html-cache";

export const CHAT_INFO_ASSISTANT_ID = "story-assistant";
export const CHAT_INFO_CONVERSATION_ID = "story-conversation";

const T0 = 1_760_000_000_000;

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
function previewHtml(title: string, lines: string[]): string {
  const items = lines.map((line) => `<li>${line}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}h1{margin:0 0 12px;font-size:28px}ul{margin:0;padding-left:22px;font-size:18px;line-height:1.7}</style><h1>${title}</h1><ul>${items}</ul>`;
}

/** The first `count` fixture apps, newest first. */
export function chatInfoApps(count: number): AppSummary[] {
  return APP_SEEDS.slice(0, count).map((seed, index) => ({
    id: `app-${index + 1}`,
    name: seed.name,
    icon: seed.icon,
    createdAt: T0,
    updatedAt: T0 + (count - index) * 1_000,
    version: "1.0.0",
    contentId: `content-${index + 1}`,
    origin: "workspace",
  }));
}

const DOCUMENT_TITLES = [
  "Trip Notes",
  "Harbour Itinerary",
  "Ferry Booking Summary",
];

/** The first `count` fixture documents, newest first. */
export function chatInfoDocuments(count: number): DocumentSummary[] {
  return DOCUMENT_TITLES.slice(0, count).map((title, index) => ({
    surfaceId: `surface-${index + 1}`,
    conversationId: CHAT_INFO_CONVERSATION_ID,
    title,
    wordCount: 320 + index * 140,
    createdAt: T0,
    updatedAt: T0 + (count - index) * 1_000,
  }));
}

/**
 * Two transcript rows carrying `attachments`: the user's upload, then the
 * assistant's reply. This is the source `useConversationAttachments` reads,
 * so the panel's Documents & Images row lists exactly these files.
 */
export function chatInfoMessages(
  attachments: DisplayAttachment[],
): DisplayMessage[] {
  const half = Math.ceil(attachments.length / 2);
  return [
    {
      id: "msg-user",
      role: "user",
      timestamp: T0,
      textSegments: ["Here are the shots from the harbour."],
      contentOrder: [{ type: "text", id: "0" }],
      attachments: attachments.slice(0, half),
    },
    {
      id: "msg-assistant",
      role: "assistant",
      timestamp: T0 + 1_000,
      textSegments: ["Added them to the trip notes."],
      contentOrder: [{ type: "text", id: "0" }],
      attachments: attachments.slice(half),
    },
  ];
}

/**
 * Fills the query cache the way the daemon would, and primes each app's html
 * so the tiles render a live preview instead of the icon placeholder.
 */
export function seedChatInfoQueries(
  client: QueryClient,
  { apps, documents }: { apps: AppSummary[]; documents: DocumentSummary[] },
): void {
  const path = { assistant_id: CHAT_INFO_ASSISTANT_ID };
  const query = { conversationId: CHAT_INFO_CONVERSATION_ID };
  client.setQueryData(appsGetQueryKey({ path, query }), { apps });
  // The app options menu reads the unscoped list to know whether a pin exists.
  client.setQueryData(appsGetQueryKey({ path }), { apps });
  client.setQueryData(documentsGetQueryKey({ path, query }), { documents });
  for (const [index, app] of apps.entries()) {
    const seed = APP_SEEDS[index % APP_SEEDS.length]!;
    primeAppHtmlCache(
      CHAT_INFO_ASSISTANT_ID,
      app.id,
      previewHtml(app.name, seed.lines),
    );
  }
}

/** Installs `messages` as the rendered transcript. */
export function seedChatInfoTranscript(messages: DisplayMessage[]): void {
  useChatSessionStore.getState().seedSnapshot(CHAT_INFO_CONVERSATION_ID, {
    messages,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    seq: 1,
  });
}

/** Drops the seeded transcript, so a story cannot leak into the next one. */
export function resetChatInfoTranscript(): void {
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
}

/**
 * The Chat Info panel's file tile, in each of the states it settles into: a
 * document, an image it already holds, an image it has to fetch, an image it
 * cannot get, a non-image glyph, a video poster, and a camera frame labelled
 * with when it was captured.
 *
 * `LazyImage` seeds the shared `attachmentContent` cache entry the tile reads,
 * which is the same entry the preview modal uses, so the story shows the
 * fetched path without a daemon behind it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  makeDisplayAttachment,
  makeSamplePreview,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import type { DocumentSummary } from "@/types/document-types";

import { ChatInfoFileTile } from "./chat-info-file-tile";

const ASSISTANT_ID = "story-assistant";

const DOC: DocumentSummary = {
  surfaceId: "surface-trip-notes",
  conversationId: "conv-1",
  title: "Trip Notes",
  wordCount: 842,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_100_000,
};

const DOCUMENT_FILE: ConversationFileAsset = {
  kind: "document",
  id: `doc-${DOC.surfaceId}`,
  title: DOC.title,
  doc: DOC,
};

function attachmentFile(
  attachment: ReturnType<typeof makeDisplayAttachment>,
): ConversationFileAsset {
  return {
    kind: "attachment",
    id: `att-${attachment.id}`,
    title: attachment.filename,
    attachment,
  };
}

const INLINE_IMAGE = attachmentFile(
  makeDisplayAttachment({
    id: "harbour-at-dawn",
    filename: "harbour-at-dawn.png",
    sizeBytes: 184_320,
    previewUrl: makeSamplePreview(240, 150),
  }),
);

/** Metadata only: the tile has to fetch these bytes before it can draw them. */
const LAZY_IMAGE_ATTACHMENT = makeDisplayAttachment({
  id: "ferry-deck",
  filename: "ferry-deck.png",
  sizeBytes: 190_464,
});
const LAZY_IMAGE = attachmentFile(LAZY_IMAGE_ATTACHMENT);

const LAZY_IMAGE_UNAVAILABLE = attachmentFile(
  makeDisplayAttachment({
    id: "gulls-at-dusk",
    filename: "gulls-at-dusk.png",
    sizeBytes: 176_128,
  }),
);

const PDF_FILE = attachmentFile(
  makeDisplayAttachment({
    id: "coast-guide",
    filename: "coast-guide.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_097_152,
  }),
);

const VIDEO_FILE = attachmentFile(
  makeDisplayAttachment({
    id: "harbour-tour",
    filename: "harbour-tour.mp4",
    mimeType: "video/mp4",
    sizeBytes: 8_388_608,
    thumbnailUrl: makeSamplePreview(240, 150),
  }),
);

const FRAME_FILE: ConversationFileAsset = {
  kind: "frame",
  id: "frame-capture-1",
  title: "camera-frame-01.jpg",
  attachment: makeDisplayAttachment({
    id: "camera-frame-01",
    filename: "camera-frame-01.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 98_304,
    previewUrl: SAMPLE_PREVIEWS[3]!,
  }),
  capturedAt: Date.UTC(2026, 4, 27, 9, 41),
};

/** The bytes the daemon would return, decoded from a sample preview data URL. */
function blobFromDataUrl(dataUrl: string): Blob {
  const [prefix, payload] = dataUrl.split(",");
  const binary = atob(payload!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], {
    type: prefix!.slice("data:".length).replace(";base64", ""),
  });
}

const storyClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
storyClient.setQueryData(
  ["attachmentContent", ASSISTANT_ID, LAZY_IMAGE_ATTACHMENT.id],
  blobFromDataUrl(SAMPLE_PREVIEWS[2]!),
);

const withSeededBytes: Decorator = (Story) => (
  <QueryClientProvider client={storyClient}>
    <Story />
  </QueryClientProvider>
);

const meta: Meta<typeof ChatInfoFileTile> = {
  title: "Chat/ChatInfoFileTile",
  component: ChatInfoFileTile,
  parameters: { layout: "centered" },
  decorators: [withSeededBytes],
  args: {
    file: DOCUMENT_FILE,
    assistantId: ASSISTANT_ID,
    onOpen: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatInfoFileTile>;

/** A daemon document: the text glyph, and the only tile kind with a menu. */
export const Document: Story = {};

/** An image the transcript already carries, drawn straight from its data URL. */
export const InlineImage: Story = {
  args: { file: INLINE_IMAGE },
};

/** An image whose bytes the tile fetches once it is on screen. */
export const LazyImage: Story = {
  args: { file: LAZY_IMAGE },
};

/** The same path with nothing to fetch: the tile settles on the image glyph. */
export const LazyImageUnavailable: Story = {
  args: { file: LAZY_IMAGE_UNAVAILABLE },
};

/** A non-image attachment, which is always its kind's glyph. */
export const Pdf: Story = {
  args: { file: PDF_FILE },
};

/** A video, painted from its poster frame rather than an image element. */
export const VideoPoster: Story = {
  args: { file: VIDEO_FILE },
};

/** A camera frame, labelled with when it was captured rather than its filename. */
export const Frame: Story = {
  args: { file: FRAME_FILE },
};

/** Four tiles at the panel's 8px gutter, the way a row of them reads together. */
export const Row: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <div className="flex gap-2">
      <ChatInfoFileTile {...args} file={DOCUMENT_FILE} />
      <ChatInfoFileTile {...args} file={INLINE_IMAGE} />
      <ChatInfoFileTile {...args} file={PDF_FILE} />
      <ChatInfoFileTile {...args} file={FRAME_FILE} />
    </div>
  ),
};

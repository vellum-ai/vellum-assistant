import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import {
  makeDisplayAttachment,
  makePreviewableImages,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";

/**
 * The assistant-message attachment strip. Past five attachments it collapses
 * to the first five squares plus a `+N` tile that opens the files panel. The
 * cap is type blind: images, video, documents and archives all count toward
 * it.
 */

const MIXED: DisplayAttachment[] = [
  makeDisplayAttachment({
    id: "deck-1",
    filename: "On_Site_Safety.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 4_194_304,
  }),
  ...makePreviewableImages(2),
  makeDisplayAttachment({
    id: "report-1",
    filename: "annual-report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_097_152,
  }),
  makeDisplayAttachment({
    id: "slide-17",
    filename: "slide-17.png",
    sizeBytes: 192_512,
    previewUrl: SAMPLE_PREVIEWS[3]!,
  }),
  makeDisplayAttachment({
    id: "bundle-1",
    filename: "source-bundle.zip",
    mimeType: "application/zip",
    sizeBytes: 8_388_608,
  }),
  makeDisplayAttachment({
    id: "cover-1",
    filename: "cover.png",
    sizeBytes: 196_608,
    previewUrl: SAMPLE_PREVIEWS[4]!,
  }),
  makeDisplayAttachment({
    id: "sheet-1",
    filename: "forecast.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 65_536,
  }),
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--border-base)] pb-6">
      <span className="text-xs uppercase tracking-wide text-[var(--content-tertiary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

const meta: Meta = {
  title: "Chat/AttachmentStrip",
  parameters: { layout: "fullscreen" },
};
export default meta;

/** Every count at which the strip changes behaviour. */
export const Counts: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-6 bg-[var(--surface-base)] p-8">
      <Row label="3 photos - under the limit, no tile">
        <MessageAttachments
          attachments={makePreviewableImages(3)}
          messageId="m-3"
        />
      </Row>
      <Row label="5 photos - exactly at the limit, still no tile">
        <MessageAttachments
          attachments={makePreviewableImages(5)}
          messageId="m-5"
        />
      </Row>
      <Row label="6 photos - first overflow, +1">
        <MessageAttachments
          attachments={makePreviewableImages(6)}
          messageId="m-6"
        />
      </Row>
      <Row label="8 mixed files - pptx / pdf / zip count toward the cap, +3">
        <MessageAttachments attachments={MIXED} messageId="m-mixed" />
      </Row>
      <Row label="41 photos - +36">
        <MessageAttachments
          attachments={makePreviewableImages(41)}
          messageId="m-41"
        />
      </Row>
    </div>
  ),
};

/**
 * Every state a square can land on. Only the first has a decodable preview;
 * the rest fall back to the file-kind icon, which is the common case for large
 * images the daemon does not inline and for attachments rehydrated from a
 * text summary.
 */
export const Fallbacks: StoryObj = {
  render: () => {
    const cases: Array<[string, DisplayAttachment]> = [
      [
        "image + preview",
        makeDisplayAttachment({
          id: "f1",
          filename: "photo.png",
          sizeBytes: 184_320,
          previewUrl: SAMPLE_PREVIEWS[0]!,
        }),
      ],
      [
        "image, no preview",
        makeDisplayAttachment({
          id: "f2",
          filename: "large-photo.png",
          sizeBytes: 24_117_248,
        }),
      ],
      [
        "image, decode fails",
        makeDisplayAttachment({
          id: "f3",
          filename: "shot.heic",
          mimeType: "image/heic",
          sizeBytes: 3_145_728,
          previewUrl: "data:image/heic;base64,AAAAAAAA",
        }),
      ],
      [
        "video + poster",
        makeDisplayAttachment({
          id: "f4",
          filename: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 12_582_912,
          thumbnailUrl: SAMPLE_PREVIEWS[3]!,
        }),
      ],
      [
        "video, no poster",
        makeDisplayAttachment({
          id: "f5",
          filename: "raw.mov",
          mimeType: "video/quicktime",
          sizeBytes: 8_388_608,
        }),
      ],
      [
        "pdf",
        makeDisplayAttachment({
          id: "f6",
          filename: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2_097_152,
        }),
      ],
      [
        "zip",
        makeDisplayAttachment({
          id: "f7",
          filename: "bundle.zip",
          mimeType: "application/zip",
          sizeBytes: 8_388_608,
        }),
      ],
      [
        "spreadsheet",
        makeDisplayAttachment({
          id: "f8",
          filename: "data.csv",
          mimeType: "text/csv",
          sizeBytes: 65_536,
        }),
      ],
      [
        "audio",
        makeDisplayAttachment({
          id: "f9",
          filename: "voice.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 1_048_576,
        }),
      ],
      [
        "code",
        makeDisplayAttachment({
          id: "f10",
          filename: "migrate.ts",
          mimeType: "text/plain",
          sizeBytes: 9_216,
        }),
      ],
      [
        "unknown",
        makeDisplayAttachment({
          id: "f11",
          filename: "firmware.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 524_288,
        }),
      ],
    ];
    return (
      <div className="flex flex-wrap gap-6 bg-[var(--surface-base)] p-8">
        {cases.map(([label, att]) => (
          <div key={att.id} className="flex w-[110px] flex-col gap-2">
            <MessageAttachments attachments={[att]} messageId={`fb-${att.id}`} />
            <span className="text-[11px] uppercase tracking-wide text-[var(--content-tertiary)]">
              {label}
            </span>
          </div>
        ))}
      </div>
    );
  },
};

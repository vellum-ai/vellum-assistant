/**
 * Read-only preview of a PowerPoint deck, rendered from content extracted in
 * the browser by `parsePptx`. One card per slide in a vertical list; the
 * surrounding host owns scrolling.
 */

import type { ReactNode } from "react";

import type { PptxSlide } from "@/domains/chat/components/local-file/preview/ooxml";
import { parsePptx } from "@/domains/chat/components/local-file/preview/ooxml";
import { PptxSlideCard } from "@/domains/chat/components/local-file/preview/pptx-slide-card";
import { PreviewEmpty } from "@/domains/chat/components/local-file/preview/preview-empty";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useOoxmlParse } from "@/domains/chat/components/local-file/preview/use-ooxml-parse";

export interface PptxPreviewProps {
  blob: Blob;
  filename: string;
}

function hasRenderableContent(slide: PptxSlide): boolean {
  return (
    slide.title !== null ||
    slide.paragraphs.length > 0 ||
    slide.imageMediaPaths.length > 0
  );
}

export function PptxPreview({ blob, filename }: PptxPreviewProps): ReactNode {
  const state = useOoxmlParse(blob, parsePptx);

  if (state.status === "loading") {
    return <PreviewSkeleton />;
  }
  if (state.status === "error") {
    return <PreviewError filename={filename} />;
  }
  if (!state.content.slides.some(hasRenderableContent)) {
    return <PreviewEmpty />;
  }

  return (
    <div className="flex flex-col gap-3 px-1 py-2">
      {state.content.slides.map((slide) => (
        <PptxSlideCard
          key={slide.index}
          slide={slide}
          mediaUrls={state.mediaUrls}
        />
      ))}
    </div>
  );
}

import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import type { PptxSlide } from "@/domains/chat/components/local-file/preview/ooxml";
import { PreviewRuns } from "@/domains/chat/components/local-file/preview/preview-runs";

/** Indent added per outline level of a body paragraph. */
const LEVEL_INDENT_REM = 1.25;

interface PptxSlideCardProps {
  slide: PptxSlide;
  /** Media path to object URL, for the images this slide references. */
  mediaUrls: Map<string, string>;
}

/** One slide of a deck: its number, its title, its body text, its pictures. */
export function PptxSlideCard({
  slide,
  mediaUrls,
}: PptxSlideCardProps): ReactNode {
  const imageUrls = slide.imageMediaPaths
    .map((path) => mediaUrls.get(path))
    .filter((url): url is string => url !== undefined);

  return (
    <section className="rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-4">
      <Typography
        as="span"
        variant="label-small-default"
        className="block text-[var(--content-tertiary)]"
      >
        {`Slide ${slide.index}`}
      </Typography>

      {slide.title !== null && (
        <Typography
          as="h3"
          variant="title-small"
          className="mt-2 text-[var(--content-default)]"
        >
          {slide.title}
        </Typography>
      )}

      {slide.paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="mt-2 whitespace-pre-wrap text-body-medium-lighter text-[var(--content-default)]"
          style={{ marginLeft: `${paragraph.level * LEVEL_INDENT_REM}rem` }}
        >
          <PreviewRuns runs={paragraph.runs} />
        </p>
      ))}

      {imageUrls.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {imageUrls.map((url, index) => (
            <img
              key={index}
              src={url}
              alt=""
              className="max-h-60 w-full rounded object-contain"
            />
          ))}
        </div>
      )}
    </section>
  );
}

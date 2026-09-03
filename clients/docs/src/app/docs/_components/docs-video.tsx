"use client";

import { Play } from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";

import {
  DOCS_VIDEOS,
  type DocsVideoSlug,
  VIDEO_POSTER_HEIGHT,
  VIDEO_POSTER_WIDTH,
  embedUrl,
  formatDuration,
  formatWatchTime,
  isoDuration,
  structuredDataEmbedUrl,
  watchUrl,
} from "@/lib/docs/videos";
import { SITE_URL } from "@/lib/metadata";

interface DocsVideoProps {
  /** Key into DOCS_VIDEOS (src/lib/docs/videos.ts). */
  video: DocsVideoSlug;
  /** Anchor id, so a page can link to or list the card in its TOC. */
  id?: string;
}

const captionLabelClass =
  "block font-sans text-sm font-semibold text-emerald-700 dark:text-emerald-300";
const captionTitleClass = "block text-sm text-stone-600 dark:text-stone-400";

/**
 * A how-to video offered as an alternative to reading the page, rendered as
 * the first thing under the page title.
 *
 * The card is a facade: it ships a self-hosted poster and swaps in the YouTube
 * player only once someone presses play, so a page that nobody watches costs
 * no third-party script, no YouTube cookie, and no request to Google. The
 * facade is a real link to the watch URL that JavaScript upgrades in place —
 * which is also what puts the video in the Markdown mirrors, llms.txt, and the
 * search index, where an iframe would leave nothing behind.
 */
export function DocsVideo({ video: slug, id }: DocsVideoProps) {
  const video = DOCS_VIDEOS[slug];
  const [playing, setPlaying] = useState(false);
  const href = watchUrl(video);

  const handlePlay = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    // Leave modified and non-primary clicks alone so "open in a new tab" still
    // reaches YouTube.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    setPlaying(true);
  }, []);

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.title,
    description: video.description,
    thumbnailUrl: `${SITE_URL}${video.poster}`,
    uploadDate: video.uploadDate,
    duration: isoDuration(video.durationSeconds),
    embedUrl: structuredDataEmbedUrl(video),
    contentUrl: href,
    publisher: { "@type": "Organization", name: "Vellum" },
  };

  return (
    <figure
      id={id}
      className="not-prose mb-10 overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-moss-600/50 dark:bg-moss-700"
    >
      {playing ? (
        <>
          <div className="relative aspect-video bg-stone-950">
            <iframe
              src={embedUrl(video)}
              title={video.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="absolute inset-0 h-full w-full border-0"
            />
          </div>
          <figcaption className="flex items-start gap-3 border-t border-stone-200 px-4 py-3 dark:border-moss-600/50">
            <span className="min-w-0">
              <span className={captionTitleClass}>
                {video.title} ·{" "}
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-emerald-700 underline hover:text-emerald-800 dark:text-emerald-300"
                >
                  Watch on YouTube
                </a>
              </span>
            </span>
          </figcaption>
        </>
      ) : (
        <a
          href={href}
          onClick={handlePlay}
          target="_blank"
          rel="noopener noreferrer"
          className="group block focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-600"
        >
          <div className="relative aspect-video bg-stone-950">
            {/* Decorative: the caption below carries the video's title. */}
            <Image
              src={video.poster}
              alt=""
              width={VIDEO_POSTER_WIDTH}
              height={VIDEO_POSTER_HEIGHT}
              unoptimized
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="absolute inset-0 bg-stone-950/10 transition-colors group-hover:bg-stone-950/25 motion-reduce:transition-none" />
            {/* The play button sits on the poster, which does not change with
                the theme, so it uses colors docs-theme.css leaves alone —
                bg-white and text-emerald-* are both remapped to theme
                surfaces inside .docs-shell. */}
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-stone-50 shadow-lg transition-transform group-hover:scale-110 motion-reduce:transition-none">
                <Play size={26} className="ml-1 fill-emerald-700 stroke-emerald-700" />
              </span>
            </span>
            <span
              aria-hidden
              className="absolute right-3 bottom-3 rounded-md bg-stone-950/80 px-1.5 py-0.5 font-sans text-xs font-medium text-white tabular-nums"
            >
              {formatDuration(video.durationSeconds)}
            </span>
          </div>
          <figcaption className="flex items-start gap-3 border-t border-stone-200 px-4 py-3 dark:border-moss-600/50">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <Play size={11} className="ml-px fill-current" />
            </span>
            <span className="min-w-0">
              <span className={captionLabelClass}>Prefer to watch?</span>{" "}
              <span className={captionTitleClass}>
                {video.title}{" "}
                <span className="whitespace-nowrap text-stone-500">
                  · {formatWatchTime(video.durationSeconds)}
                </span>
              </span>
            </span>
          </figcaption>
        </a>
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
    </figure>
  );
}

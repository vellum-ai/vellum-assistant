/**
 * How-to videos embedded in the docs, keyed by slug.
 *
 * Pages reference a video by slug rather than passing its metadata inline, so
 * a video that belongs on two pages carries one title, one duration, and one
 * poster. See clients/docs/AGENTS.md → "Embedding a how-to video".
 */

export interface DocsVideo {
  /** YouTube video id — the `v` parameter of the watch URL. */
  youtubeId: string;
  /** Title as published on YouTube. */
  title: string;
  /** One sentence on what the video covers, used for the VideoObject
   *  structured data. */
  description: string;
  /** Runtime in seconds. */
  durationSeconds: number;
  /** Publication date, ISO 8601 with a UTC offset. */
  uploadDate: string;
  /** Self-hosted poster under public/docs/, 1280×720 WebP. */
  poster: string;
}

/** Every poster is the 1280×720 YouTube frame converted to WebP, so the
 *  intrinsic dimensions are the same for all of them. Images are unoptimized;
 *  these declared dimensions are what prevents layout shift. */
export const VIDEO_POSTER_WIDTH = 1280;
export const VIDEO_POSTER_HEIGHT = 720;

export const DOCS_VIDEOS = {
  "local-hosting-setup": {
    youtubeId: "SJgflx6XDeQ",
    title: "How to setup a locally hosted Vellum AI assistant in under 5 minutes",
    description:
      "A walkthrough of installing Vellum and running your assistant locally on your own Mac.",
    durationSeconds: 205,
    uploadDate: "2026-08-25T11:06:40-07:00",
    poster: "/docs/video-local-hosting-setup.webp",
  },
  "mobile-pairing": {
    youtubeId: "LL8N3j91Yg4",
    title: "How to use your locally hosted AI assistant on mobile",
    description:
      "A walkthrough of opening a tunnel to a self-hosted assistant and pairing a phone with it.",
    durationSeconds: 181,
    uploadDate: "2026-08-25T10:36:38-07:00",
    poster: "/docs/video-mobile-pairing.webp",
  },
  "gcp-vm-setup": {
    youtubeId: "7kwHOvhk8Nk",
    title: "How to set up a Vellum AI assistant on Google Cloud VPS/VM",
    description:
      "A walkthrough of provisioning a Compute Engine VM in your own Google Cloud project and running your assistant on it.",
    durationSeconds: 650,
    uploadDate: "2026-09-02T12:19:40-07:00",
    poster: "/docs/video-gcp-vm-setup.webp",
  },
  "always-on-assistant": {
    youtubeId: "S_iAv6c_-6E",
    title: "How to set up a free AI Assistant that works while you sleep",
    description:
      "A walkthrough of setting up an assistant on Vellum Cloud so it keeps running when your computer is off.",
    durationSeconds: 227,
    uploadDate: "2026-09-01T11:17:50-07:00",
    poster: "/docs/video-always-on-assistant.webp",
  },
} as const satisfies Record<string, DocsVideo>;

export type DocsVideoSlug = keyof typeof DOCS_VIDEOS;

export function watchUrl(video: DocsVideo): string {
  return `https://www.youtube.com/watch?v=${video.youtubeId}`;
}

/** Player URL for the inline embed. The nocookie host keeps YouTube from
 *  setting tracking cookies for viewers who never leave the docs. */
export function embedUrl(video: DocsVideo): string {
  return `https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0`;
}

/** Player URL for structured data, on the canonical host Google expects. */
export function structuredDataEmbedUrl(video: DocsVideo): string {
  return `https://www.youtube.com/embed/${video.youtubeId}`;
}

/** Exact runtime for the badge on the poster, e.g. "3:25". */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** Rounded runtime for prose, e.g. "3 min watch". Reads as an effort estimate
 *  next to the page it stands in for. */
export function formatWatchTime(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min watch`;
}

/** ISO 8601 duration for the VideoObject structured data, e.g. "PT3M25S". */
export function isoDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `PT${minutes}M${remainder}S`;
}

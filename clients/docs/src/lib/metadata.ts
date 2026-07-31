import type { Metadata } from "next";

import { agentMarkdownPathForPage } from "@/lib/agent-markdown-paths";
import { WWW_DOMAIN } from "@/lib/domains";

export const SITE_URL = `https://${WWW_DOMAIN}`;
const DEFAULT_OG_IMAGE = `${SITE_URL}/docs/og.png`;
const TWITTER_HANDLE = "@vellum_ai";

// The OG image is a static 1200x630 PNG served from public/. Declaring
// dimensions on the meta tags helps unfurlers (especially LinkedIn) render
// previews on first share without re-probing.
const DEFAULT_OG_IMAGE_WIDTH = 1200;
const DEFAULT_OG_IMAGE_HEIGHT = 630;

interface CreateMetadataOptions {
  title: string;
  description: string;
  path: string;
}

export function createMetadata({
  title,
  description,
  path,
}: CreateMetadataOptions): Metadata {
  const url = `${SITE_URL}${path}`;
  const markdownPath = agentMarkdownPathForPage(path);
  const markdownAlternate = markdownPath
    ? { "text/markdown": `${SITE_URL}${markdownPath}` }
    : undefined;

  return {
    title,
    description,
    alternates: {
      canonical: url,
      ...(markdownAlternate && { types: markdownAlternate }),
    },
    openGraph: {
      title,
      description,
      url,
      siteName: "Vellum",
      type: "website",
      locale: "en_US",
      images: [
        {
          url: DEFAULT_OG_IMAGE,
          width: DEFAULT_OG_IMAGE_WIDTH,
          height: DEFAULT_OG_IMAGE_HEIGHT,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title,
      description,
      images: [
        {
          url: DEFAULT_OG_IMAGE,
          alt: title,
        },
      ],
    },
  };
}

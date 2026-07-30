import type { Metadata } from "next";

import { agentMarkdownPathForPage } from "@/lib/agent-markdown-paths";
import { WWW_DOMAIN } from "@/lib/domains";

export const SITE_URL = `https://${WWW_DOMAIN}`;
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-cover-v2.jpg`;
export const TWITTER_HANDLE = "@vellum_ai";

// The default dynamic OG endpoint at /api/og renders a 1200x630 PNG.
// Declaring dimensions on the meta tags helps unfurlers (especially
// LinkedIn) render previews on first share without re-probing.
const DEFAULT_OG_IMAGE_WIDTH = 1200;
const DEFAULT_OG_IMAGE_HEIGHT = 630;

interface CreateMetadataOptions {
  title: string;
  description: string;
  path: string;
  image?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  type?: "website" | "article";
  publishedTime?: string;
  authors?: string[];
  twitterCreator?: string;
}

export function createMetadata({
  title,
  description,
  path,
  image,
  imageAlt,
  imageWidth,
  imageHeight,
  type = "website",
  publishedTime,
  authors,
  twitterCreator,
}: CreateMetadataOptions): Metadata {
  const url = `${SITE_URL}${path}`;
  const usingDefaultOgImage = !image;
  const ogImage =
    image ?? `${SITE_URL}/api/og?title=${encodeURIComponent(title)}`;
  const ogImageAlt = imageAlt ?? title;
  // Only assume dimensions for the default endpoint. Custom images may be
  // arbitrary sizes (showcase avatars, blog hero art, etc.).
  const width =
    imageWidth ?? (usingDefaultOgImage ? DEFAULT_OG_IMAGE_WIDTH : undefined);
  const height =
    imageHeight ?? (usingDefaultOgImage ? DEFAULT_OG_IMAGE_HEIGHT : undefined);

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
      type,
      locale: "en_US",
      images: [
        {
          url: ogImage,
          ...(width !== undefined && { width }),
          ...(height !== undefined && { height }),
          alt: ogImageAlt,
        },
      ],
      ...(publishedTime && { publishedTime }),
      ...(authors && { authors }),
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: twitterCreator ?? TWITTER_HANDLE,
      title,
      description,
      images: [
        {
          url: ogImage,
          alt: ogImageAlt,
        },
      ],
    },
  };
}

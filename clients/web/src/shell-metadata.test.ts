import { readFileSync } from "fs";
import path from "path";

import { describe, expect, test } from "bun:test";

/**
 * nginx serves `index.html` for every SPA route, so the Open Graph tags in it
 * are the *only* link preview metadata `/account/signup`, `/account/login`,
 * and `/assistant/...` will ever have. These tests pin that contract. The tags
 * are easy to drop by accident, and the loss stays invisible until someone
 * pastes a link somewhere and gets a bare URL.
 */
const INDEX_HTML = readFileSync(
  path.join(import.meta.dir, "..", "index.html"),
  "utf8",
);

const doc = new DOMParser().parseFromString(INDEX_HTML, "text/html");

function ogTag(property: string): string | null {
  return (
    doc
      .querySelector(`meta[property="${property}"]`)
      ?.getAttribute("content") ?? null
  );
}

function nameTag(name: string): string | null {
  return (
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null
  );
}

const EXPECTED_TITLE = "Vellum: Your Personal Intelligence";
const EXPECTED_IMAGE = "https://www.vellum.ai/og-cover-v2.jpg";

describe("SPA shell: Open Graph metadata", () => {
  test("declares the tags an unfurler needs for a large image card", () => {
    expect(ogTag("og:title")).toBe(EXPECTED_TITLE);
    expect(ogTag("og:description")).toBeTruthy();
    expect(ogTag("og:image")).toBe(EXPECTED_IMAGE);
    expect(ogTag("og:type")).toBe("website");
    expect(ogTag("og:site_name")).toBe("Vellum");
  });

  test("declares the image dimensions so cards render on first share", () => {
    expect(ogTag("og:image:width")).toBe("1200");
    expect(ogTag("og:image:height")).toBe("630");
    expect(ogTag("og:image:alt")).toBe(EXPECTED_TITLE);
  });

  test("declares a matching Twitter card", () => {
    expect(nameTag("twitter:card")).toBe("summary_large_image");
    expect(nameTag("twitter:site")).toBe("@vellum_ai");
    expect(nameTag("twitter:title")).toBe(EXPECTED_TITLE);
    expect(nameTag("twitter:description")).toBeTruthy();
    expect(nameTag("twitter:image")).toBe(EXPECTED_IMAGE);
  });

  test("og and twitter descriptions agree with the meta description", () => {
    const description = nameTag("description");
    expect(description).toBeTruthy();
    expect(ogTag("og:description")).toBe(description);
    expect(nameTag("twitter:description")).toBe(description);
  });

  // This file is also served from assistant.* hosts and loaded inside the
  // Capacitor WKWebView, where a relative path resolves against a host with no
  // such asset. The apex vellum.ai 308-redirects and some unfurlers drop a
  // redirecting image.
  test("image URLs are absolute and on the canonical www host", () => {
    for (const url of [ogTag("og:image"), nameTag("twitter:image")]) {
      expect(url).toMatch(/^https:\/\/www\.vellum\.ai\//);
    }
  });

  // og:url can only name one route, and unfurlers treat it as canonical, so a
  // /account/signup link would unfurl as whichever route was hardcoded.
  test("omits og:url so each crawler uses the URL it fetched", () => {
    expect(ogTag("og:url")).toBeNull();
  });

  // Previews are enabled via a dedicated link-preview-bot group in the
  // marketing site's robots.txt, not by making the app shell indexable.
  test("keeps the app shell out of the search index", () => {
    expect(nameTag("robots")).toBe("noindex, nofollow");
  });
});

import { readFileSync } from "fs";
import path from "path";

import { describe, expect, test } from "bun:test";

import { loadCatalogs, type LocaleCatalogs } from "@/i18n/catalogs";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/i18n/supported-locales";

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

/**
 * The shell-init script is the inline `<script>` in the head: the only script
 * without a `src`. Inline is load-bearing (an external file is a fetch that
 * can block the parser ahead of the splash or go stale in HTTP caches), so
 * these tests read it out of the document rather than off disk.
 */
const SHELL_INIT = (() => {
  const inline = [...doc.querySelectorAll("script:not([src])")];
  if (inline.length !== 1) {
    throw new Error(
      `expected exactly one inline script in index.html, found ${inline.length}`,
    );
  }
  return inline[0]?.textContent ?? "";
})();

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

/**
 * The boot splash is the only UI a user sees before the bundle exists, so its
 * accessible label cannot come from i18next. `index.html` carries the English
 * one and the inline shell script swaps in a translation for the locales that
 * have one. These tests hold the two halves to the catalogs, which is the only
 * thing keeping the pre-bundle label and the post-bundle one in agreement.
 */
const CATALOGS: Record<string, LocaleCatalogs> = Object.fromEntries(
  await Promise.all(
    SUPPORTED_LOCALES.map(async (locale) => [locale, await loadCatalogs(locale)]),
  ),
);

/** A locale's generic loading label, or `undefined` when it does not have one. */
function loadingLabel(locale: string): string | undefined {
  const group = CATALOGS[locale]?.common.rootHydrateFallback;
  if (group === null || typeof group !== "object") {
    return undefined;
  }
  const label = (group as Record<string, unknown>).loadingAria;
  return typeof label === "string" ? label : undefined;
}

describe("SPA shell: boot splash", () => {
  const splash = doc.querySelector("#boot-splash");

  test("announces itself as a live status region", () => {
    expect(splash?.getAttribute("role")).toBe("status");
  });

  // An external shell script is a fetch: it can block the parser ahead of
  // the splash on a cache miss, and a previously cached copy can outlive the
  // HTML that references it. Inline, it executes before the splash parses
  // with nothing to fetch and nothing to go stale.
  test("the shell init is inline, not an external fetch", () => {
    expect(SHELL_INIT).toContain("data-theme");
    expect(doc.querySelector('script[src*="theme-init"]')).toBeNull();
  });

  test("its static label is the same string the app's own spinner uses", () => {
    expect(splash?.getAttribute("aria-label")).toBe(
      loadingLabel(DEFAULT_LOCALE),
    );
  });

  test("the shell init carries the exact label every other locale translates", () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) {
        continue;
      }
      const label = loadingLabel(locale);
      if (label === undefined) {
        continue;
      }
      expect(SHELL_INIT).toContain(`${locale}: ${JSON.stringify(label)}`);
    }
  });

  // Negotiation has to know every shipped locale, not just the translated
  // ones: a preference for a locale with no label of its own must resolve to
  // English rather than falling through to the next tag the host lists.
  test("the shell init negotiates over the whole shipped locale set", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(SHELL_INIT).toContain(JSON.stringify(locale));
    }
  });

  // Reading storage throws where it is disabled rather than returning null.
  // Only its own catch keeps that throw from skipping the host's languages,
  // which is the half of negotiation a storage-less browser still has.
  test("the shell init reads the stored preference behind its own catch", () => {
    expect(SHELL_INIT).toMatch(
      /try\s*\{\s*stored\s*=\s*window\.localStorage\.getItem\("device:locale"\);\s*\}\s*catch/,
    );
  });

  // DOMContentLoaded is gated on the module script's whole dependency graph,
  // which is the very download the splash covers, so waiting for it would
  // localize the label only after the splash is gone. The observer is what
  // lands the label while the splash is still on screen.
  test("the shell init applies the label without waiting for DOMContentLoaded", () => {
    expect(SHELL_INIT).toContain("new MutationObserver");
  });
});

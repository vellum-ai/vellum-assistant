"use client";

import { useEffect } from "react";

export function UTMTracker() {
  useEffect(() => {
    // UTM tracking logic from vellum.ai
    const KEY = "first_touch_utms";

    // Helper functions
    function U() {
      return new URL(window.location.href);
    }
    function S(k: string, o: Record<string, string>) {
      try {
        localStorage.setItem(k, JSON.stringify(o));
      } catch (e) {
        // Silently fail if localStorage is unavailable
      }
    }
    function L(k: string): Record<string, string> {
      try {
        return JSON.parse(localStorage.getItem(k) || "{}");
      } catch (e) {
        return {};
      }
    }
    function pick(sp: URLSearchParams): Record<string, string> {
      const keys = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "gclid",
        "gbraid",
        "wbraid",
        "msclkid",
        "fbclid",
        "ttclid",
      ];
      const out: Record<string, string> = {};
      keys.forEach((k) => {
        if (sp.get(k)) out[k] = sp.get(k)!;
      });
      return out;
    }

    // Normalize AI sources
    function normalizeAI(src: string | null): {
      source: string;
      medium: string;
    } | null {
      const v = (src || "").toLowerCase();
      if (!v) return null;
      if (v.includes("chatgpt") || v.includes("openai"))
        return { source: "chatgpt", medium: "geo" };
      if (v.includes("perplexity"))
        return { source: "perplexity", medium: "geo" };
      if (v.includes("claude") || v.includes("anthropic"))
        return { source: "claude", medium: "geo" };
      return null;
    }

    // Infer source when no UTMs
    function infer(sp: URLSearchParams): Record<string, string> {
      const ref = document.referrer || "";
      let host = "";
      try {
        host = new URL(ref).host.toLowerCase();
      } catch (e) {
        // Invalid URL
      }
      const ua = (navigator.userAgent || "").toLowerCase();

      // Check for paid click IDs
      const paidIds = [
        "gclid",
        "gbraid",
        "wbraid",
        "msclkid",
        "fbclid",
        "ttclid",
      ];
      if (paidIds.some((k) => sp.has(k))) {
        if (host.includes("google."))
          return { utm_source: "google", utm_medium: "cpc" };
        if (host.includes("bing.com"))
          return { utm_source: "bing", utm_medium: "cpc" };
        if (host.includes("facebook.com") || host.includes("instagram.com"))
          return { utm_source: "facebook", utm_medium: "paid_social" };
        if (host.includes("linkedin.com"))
          return { utm_source: "linkedin", utm_medium: "paid_social" };
        if (
          host.includes("x.com") ||
          host.includes("twitter.com") ||
          host.includes("t.co")
        )
          return { utm_source: "x", utm_medium: "paid_social" };
        return { utm_source: host || "unknown", utm_medium: "cpc" };
      }

      // Search engines
      if (host.includes("google."))
        return { utm_source: "google", utm_medium: "organic" };
      if (host.includes("bing.com"))
        return { utm_source: "bing", utm_medium: "organic" };

      // AI sources
      if (
        host.includes("chat.openai.com") ||
        host.includes("chatgpt.com") ||
        host.includes("r.openai.com")
      )
        return { utm_source: "chatgpt", utm_medium: "geo" };
      if (host.includes("claude.ai") || host.includes("anthropic.com"))
        return { utm_source: "claude", utm_medium: "geo" };
      if (host.includes("perplexity.ai"))
        return { utm_source: "perplexity", utm_medium: "geo" };

      // Social
      if (
        host.includes("x.com") ||
        host.includes("twitter.com") ||
        host.includes("t.co")
      )
        return { utm_source: "x", utm_medium: "social" };
      if (host.includes("facebook.com") || host.includes("instagram.com"))
        return { utm_source: "facebook", utm_medium: "social" };
      if (host.includes("linkedin.com"))
        return { utm_source: "linkedin", utm_medium: "social" };

      // Direct or referral
      if (!ref) {
        if (ua.includes("chatgpt"))
          return { utm_source: "chatgpt", utm_medium: "geo" };
        if (ua.includes("anthropic") || ua.includes("claude"))
          return { utm_source: "claude", utm_medium: "geo" };
        return { utm_source: "direct", utm_medium: "none" };
      }
      return { utm_source: host || "unknown", utm_medium: "referral" };
    }

    // Main tracking logic
    const url = U();
    const s = url.searchParams;
    let ft = L(KEY) || {};
    let urlUTM = pick(s);

    // Normalize AI in URL
    if (s.has("utm_source")) {
      const norm = normalizeAI(s.get("utm_source"));
      if (norm) {
        let changed = false;
        if (s.get("utm_source") !== norm.source) {
          s.set("utm_source", norm.source);
          changed = true;
        }
        if (!s.has("utm_medium")) {
          s.set("utm_medium", norm.medium);
          changed = true;
        }
        if (changed) {
          window.history.replaceState({}, "", url.toString());
          urlUTM = pick(s);
        }
      }
    }

    // Entry detection
    const hasUTMs = Object.keys(urlUTM).length > 0;
    const curHost = window.location.hostname.replace(/^www\./, "");
    let refHost = "";
    try {
      refHost = new URL(document.referrer).hostname.replace(/^www\./, "");
    } catch (e) {
      // Invalid referrer
    }
    const cameFromOutside = !!refHost && refHost !== curHost;
    const isFirstHitThisTab = !sessionStorage.getItem("utm_session_started");
    sessionStorage.setItem("utm_session_started", "1");
    const isNewEntryNoUTM = !hasUTMs && (cameFromOutside || isFirstHitThisTab);

    // Update first-touch UTMs
    if (hasUTMs) {
      ft = urlUTM;
      const n = normalizeAI(ft.utm_source);
      if (n) {
        ft.utm_source = n.source;
        if (!ft.utm_medium) ft.utm_medium = "geo";
      }
      S(KEY, ft);
    } else if (isNewEntryNoUTM) {
      const inf = infer(s);
      if (inf.utm_source) {
        ft = { ...inf };
        S(KEY, ft);
        if (!s.has("utm_source")) s.set("utm_source", ft.utm_source);
        if (!s.has("utm_medium")) s.set("utm_medium", ft.utm_medium);
        window.history.replaceState({}, "", url.toString());
      }
    }

    // Backfill first-touch UTMs into URL
    if (ft && Object.keys(ft).length) {
      const keys = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
      ];
      let changed = false;
      keys.forEach((k) => {
        if (ft[k] && !s.has(k)) {
          s.set(k, ft[k]);
          changed = true;
        }
      });
      if (changed) window.history.replaceState({}, "", url.toString());
    }
  }, []);

  return null;
}

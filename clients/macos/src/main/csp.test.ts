import { describe, expect, test } from "bun:test";

import { CSP_POLICY } from "./csp";

/** Extract the value for a single CSP directive from the policy string. */
function directiveValue(directive: string): string | undefined {
  const match = CSP_POLICY.match(new RegExp(`(?:^|;\\s*)${directive}\\s+([^;]+)`));
  return match?.[1]?.trim();
}

describe("CSP_POLICY", () => {
  test("contains all required directives", () => {
    const required = [
      "default-src",
      "script-src",
      "style-src",
      "connect-src",
      "frame-src",
      "img-src",
      "media-src",
      "worker-src",
      "font-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
      "form-action",
    ];
    for (const dir of required) {
      expect(CSP_POLICY).toContain(dir);
    }
  });

  test("frame-src confines where a sandboxed frame can navigate", () => {
    // The only control over a srcdoc frame navigating its own browsing
    // context: no CSP directive constrains that from inside the frame, so a
    // `visual` or app-viewer frame rendering model-authored markup would
    // otherwise be free to carry conversation data out in a URL. See
    // ATL-1197.
    const frameSrc = directiveValue("frame-src");
    expect(frameSrc).toBeDefined();
    // Present, and never a wildcard or a bare scheme: the surfaces need only
    // 'self' (a srcdoc document resolves as 'self'), and every host beyond it
    // is an explicit third-party frame we chose to embed.
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).not.toContain("*;");
    expect(frameSrc).not.toMatch(/(^|\s)\*(\s|$)/);
    expect(frameSrc).not.toMatch(/(^|\s)https:(\s|$)/);
    for (const host of frameSrc!.split(/\s+/).filter((s) => s !== "'self'")) {
      expect(host.startsWith("https://")).toBe(true);
    }
  });

  test("declares frame-src exactly once", () => {
    // A repeated directive is ignored after its first occurrence, so a second
    // `frame-src` reads as if it applies and does nothing. Two changes landing
    // independently is exactly how that happens.
    const occurrences = CSP_POLICY.split(";").filter(
      (part) => part.trim().split(/\s+/)[0] === "frame-src",
    );
    expect(occurrences).toHaveLength(1);
  });

  test("script-src does not allow unsafe-eval", () => {
    const scriptSrc = directiveValue("script-src");
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("script-src allows unsafe-inline for srcdoc bridge scripts", () => {
    const scriptSrc = directiveValue("script-src");
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  test("script-src allows the platform origin for the replay recorder script", () => {
    const scriptSrc = directiveValue("script-src")!;
    expect(scriptSrc).toContain("https://*.vellum.ai");
  });

  test("media-src allows the hosted voice-preview sources", () => {
    const mediaSrc = directiveValue("media-src")!;
    // ElevenLabs premade previews are path-scoped to their public bucket
    // so the rest of GCS stays blocked for media.
    expect(mediaSrc).toContain(
      "https://storage.googleapis.com/eleven-public-prod/",
    );
    expect(mediaSrc).toContain("https://static.deepgram.com/");
    expect(mediaSrc).not.toContain("https://storage.googleapis.com ");
  });

  test("object-src is 'none'", () => {
    expect(directiveValue("object-src")).toBe("'none'");
  });

  test("frame-ancestors is 'none'", () => {
    expect(directiveValue("frame-ancestors")).toBe("'none'");
  });

  test("base-uri is 'none'", () => {
    expect(directiveValue("base-uri")).toBe("'none'");
  });

  test("connect-src allows vellum.ai and sentry but not broad https:", () => {
    const connectSrc = directiveValue("connect-src")!;
    expect(connectSrc).toContain("https://*.vellum.ai");
    expect(connectSrc).toContain("wss://*.vellum.ai");
    expect(connectSrc).toContain("https://*.ingest.sentry.io");
    expect(connectSrc).not.toMatch(/\bhttps:\s/);
  });

  test("allows the Stripe.js hosts needed by the payment-method modal", () => {
    const scriptSrc = directiveValue("script-src")!;
    expect(scriptSrc).toContain("https://js.stripe.com");
    expect(scriptSrc).toContain("https://*.js.stripe.com");

    const frameSrc = directiveValue("frame-src")!;
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).toContain("https://js.stripe.com");
    expect(frameSrc).toContain("https://*.js.stripe.com");
    expect(frameSrc).toContain("https://hooks.stripe.com");

    const connectSrc = directiveValue("connect-src")!;
    expect(connectSrc).toContain("https://api.stripe.com");
  });

  test("connect-src allows loopback gateway WebSockets but not broad ws:", () => {
    const connectSrc = directiveValue("connect-src")!;
    expect(connectSrc).toContain("ws://localhost:*");
    expect(connectSrc).toContain("ws://127.0.0.1:*");
    expect(connectSrc).not.toMatch(/\bws:\s/);
    expect(connectSrc).not.toContain("ws://*");
  });
});

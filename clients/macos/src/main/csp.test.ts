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

  test("script-src does not allow unsafe-eval", () => {
    const scriptSrc = directiveValue("script-src");
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("script-src allows unsafe-inline for srcdoc bridge scripts", () => {
    const scriptSrc = directiveValue("script-src");
    expect(scriptSrc).toContain("'unsafe-inline'");
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

  test("connect-src allows loopback gateway WebSockets but not broad ws:", () => {
    const connectSrc = directiveValue("connect-src")!;
    expect(connectSrc).toContain("ws://localhost:*");
    expect(connectSrc).toContain("ws://127.0.0.1:*");
    expect(connectSrc).not.toMatch(/\bws:\s/);
    expect(connectSrc).not.toContain("ws://*");
  });
});
